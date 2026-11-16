---
title: Issue pipeline — dispatcher specification
owner: Documentation Team
audience: agent
status: proposed
status_since: 2026-11-14
last_updated: 2026-11-16
tags: [agent-efficiency, github-issues, automation]
parent: issue-pipeline-automation.md
---

# Issue pipeline — dispatcher specification

Normative implementation contract for the unified issue pipeline dispatcher. Product intent and decisions: [issue-pipeline-automation.md](./issue-pipeline-automation.md).

## 1. Components

| Artifact | Purpose |
|----------|---------|
| `.github/workflows/issue-pipeline-dispatcher.yml` | Triggers, concurrency, environment secrets |
| `scripts/issue_pipeline_dispatcher.js` | Tick: enumerate work, choose actions, invoke workers |
| `scripts/issue_pipeline_state.js` | Parse `<!-- agent-state: … -->`; lane comments no longer embed state |
| `scripts/lib/pipeline_state_trust.js` | Trust allowlist (`pawpet-bot`, `pawpet-claude`) + `pipeline-state` marker |
| `scripts/issue_pipeline_state_load.js` | Upsert dedicated `<!-- pipeline-state -->` comment (bot token; newest `updated_at` wins) |
| `scripts/lib/pipeline_path_gate.js` | Shared planned-path gate (delivery, implement, P8 policy) |
| `scripts/issue_pipeline_project.js` | Pawpet Status read/write (wraps `github_issue_workflow.js` patterns) |
| `scripts/issue_pipeline_workers/` | Launch Claude action or Cursor API per lane |
| Repo variable `ISSUE_PIPELINE` | `off` \| `dry-run` \| `on` |

**Retire when parity reached:** `triage-human-reviewed.yml`, `agent-dispatch.yml`, `agent-monitor.yml` (or thin wrappers that call dispatcher only).

## 2. Triggers

| Event | Use |
|-------|-----|
| `issues: assigned` | Primary — start lane for new assignee |
| `issues: labeled`, `issues: edited` | Secondary — delivery labels, `question` cleared |
| `issue_comment` (issue only — skip when `issue.pull_request` is set) | Re-queue intake after author answers |
| `pull_request_target: closed` (merged) | Release tracking, WIP slot free |
| `workflow_run` (deploy-uat, deploy-prod, CI) | UAT/Prod notify alignment |
| `schedule` (7,37 past each hour) | Heartbeat — off the half-hour to reduce missed cron ticks |
| `workflow_dispatch` | Optional scoped `issue_number` for debugging only |

**Not used:** Project v2 item events (not available as workflow triggers).

## 3. Tick algorithm

1. If `ISSUE_PIPELINE` is `off`, exit 0.
2. Load org/project field IDs from secrets (`GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, org `AgathaTrack`).
3. **Global tick:** event-driven runs never set `ISSUE_NUMBER`; recompute from the whole Pawpet board so cancelled concurrent runs do not drop issues (repair #2363 §2.2). `workflow_dispatch` may pass `issue_number` for debugging only.
4. For each open issue with label ∉ {`manual-only`, `owner-programme`, execute-plan control titles, non-automation columns} (a `manual-only` issue is skipped before any lane condition is evaluated, whatever its status or assignee). Automation columns: To do, In Analysis, Ready, In progress:
   - Read Pawpet **Status**, **assignee**, delivery labels, `busy`, `needs-owner`, state block.
   - Compute **eligible action** at most one per issue (priority table below).
5. Sort actions by priority label then issue age.
6. Apply **lane caps**; skip if cap reached.
7. If `dry-run`, log planned actions only.
8. Else execute: set lock (`busy` / marker), call worker or deterministic script, update assignee/status with **bot PAT** (not `GITHUB_TOKEN` for handoffs).

### 3.1 Action priority (per issue)

| Order | Condition | Action |
|-------|-----------|--------|
| 0 | `manual-only` | None (excluded from every lane) |
| 1 | `needs-owner` + assignee `KanopeeKa` | None (wait for human) |
| 2 | Status To do + assignee `pawpet-claude` + no `question` | Triage then intake worker |
| 3 | Status In Analysis + assignee ∈ bots | Review worker |
| 3a | Live `body_sha` ≠ state `body_sha`, or **In Analysis** with a delivery label, or **Ready** + delivery label without `converged_at` for current body | Reopen worker: **In Analysis**, strip delivery labels, reset `verdicts`, clear `converged_at`, assign other bot (or `needs-owner` if at round cap) |
| 4 | Status Ready + assignee `pawpet-bot` + no delivery label + `converged_at` for current `body_sha` | Delivery worker |
| 5 | Status Ready + delivery label + unassigned + WIP slot + live `body_sha` = state `body_sha` + `converged_at` set | Implement launch |
| 6 | Status In progress + assignee `pawpet-bot` | Monitor tick |
| 7 | Merged PR linked (`Refs #n`) | Hand off to existing merge handler if not already |

## 4. Lanes and concurrency

| Lane group | `concurrency` key | Cap per tick |
|------------|-------------------|--------------|
| `issue-pipeline-triage` | 1 | unlimited issues, cheap |
| `issue-pipeline-intake` | 2 | 2 Claude runs |
| `issue-pipeline-review` | 2 per bot | 2 `pawpet-claude`, 2 `pawpet-bot` |
| `issue-pipeline-delivery` | 1 | 1 |
| `issue-pipeline-implement` | WIP | §5 |
| `issue-pipeline-monitor` | 2 | 2 poll/relaunch |

Global dispatcher concurrency: `issue-pipeline-dispatcher` (single runner per repo, like today’s `agent-dispatch`).

## 5. Work-in-progress

```text
wip_in_use = count(
  distinct product issues where Status = "In progress"
    AND assignee.login = "pawpet-bot"
    AND (has label busy OR has an active light-plan | execute-plan programme)
)
```

The counting unit is the **product issue**: each holds exactly one slot, whatever its delivery method. A programme's tracking issue, phase PRs and release PR add nothing on top of it.

| Config | Default |
|--------|---------|
| `WIP_MAX` | 2 |
| Slots per product issue | 1 (`PR`, `light-plan` or `execute-plan`) |

Queued: Ready + delivery label + **no assignee**, ordered by priority label then `created_at`.

## 6. Assignment and handoff rules

### 6.1 Enforced invariants

- At most **one** assignee when dispatcher sets assignee.
- Review lane: `assignee` must ≠ `last_assignee` in state block (unless round 0 intake just set `last_assignee` from intake author).
- Before any issue write, worker re-fetches assignee; if ≠ self, abort without write.

### 6.2 Handoff table

| From step | Outcome | Next assignee | Next status |
|-----------|---------|---------------|-------------|
| Triage | pass | `pawpet-claude` | To do (stay) |
| Triage | fail / question | author or `KanopeeKa` | Backlog |
| Any | `manual-only` present (human-set) | unchanged | unchanged — dispatcher skips the issue |
| Intake | need info | author | Backlog + `question` |
| Intake | ok | `pawpet-bot` | In Analysis |
| Review | red / green+edits | other bot | In Analysis |
| Review | green, `body_sha` unchanged this round | `pawpet-bot` | Ready |
| Review | `round >= cap` (default 6) | `KanopeeKa` | + `needs-owner` |
| Review reopen | `body_sha` changed after `converged_at`, or delivery rewrite changed body | other bot or `KanopeeKa` if at cap | In Analysis; strip delivery labels; clear `converged_at`; reset `verdicts`; `round + 1` unless cap → `needs-owner` |
| Delivery | ok (body unchanged this step) | *none* | Ready + delivery label |
| Delivery | rewrite changed `body_sha` | other bot (reopen record; **no** label this pass) | In Analysis |
| Delivery | sensitive | `KanopeeKa` | + `needs-owner` |
| Implement launch | ok | `pawpet-bot` | In progress + `busy` |
| Implement launch | fail | `KanopeeKa` | + `needs-owner` |

All assignee changes in the **Action column** MUST use `EXECUTE_PLAN_BOT_TOKEN` or `PAWPET_CLAUDE_TOKEN`, not `GITHUB_TOKEN`, so `issues: assigned` fires downstream workflows.

### 6.3 Human override

If assignee changed by a human (`KanopeeKa` or other collaborator) since last bot action:

- Dispatcher records: `<!-- pipeline-note: human reassignment to @login at ISO time -->` in a comment (bot PAT).
- Next tick uses the new assignee as authoritative (no revert).

## 7. Deterministic triage (To do lane)

Extract from `triage-lib.js`:

- Issue form section presence and quality checks (existing).
- Risky keyword → hint only; **delivery** sensitivity uses `agent-paths` block later.
- Outputs: pass → continue intake; fail → Backlog + `question`. Triage never sets `manual-only`; only a human does, and the dispatcher then skips the issue (§3).

**Deprecate:** requiring `human-reviewed` for Ready dispatch. Optional: humans add `human-reviewed` only when moving Backlog → To do as audit trail — not read by dispatcher except as optional flag.

## 8. Workers

### 8.1 Claude (intake, review when assignee `pawpet-claude`)

- Runner: `anthropics/claude-code-action` or equivalent workflow job.
- Trigger: `workflow_call` from dispatcher with `issue_number`, `lane`, `dry_run`.
- Token: `PAWPET_CLAUDE_TOKEN` or job token if sufficient for assign/write.
- Output: comment (verdict text), body edits (if needed), **new state comment** (§4 in proposal), assign other bot or advance via PAT callback step.

### 8.2 Cursor (review when `pawpet-bot`, delivery, implement, monitor)

- Reuse `launch-cursor-agent.js`, `monitor-cursor-agent.js`, `agent-payload-lib.js`.
- Model policy: implement lane Composer 2.5 per `pr-review-cost-efficiency.md` cloud policy.
- Run marker: `<!-- cursor-agent-run: {"id":"…","status":"running",…} -->` (existing pattern).

## 9. Locks and staleness

| Mechanism | Rule |
|-----------|------|
| `busy` | Set on implement/monitor launch; removed on merge or explicit handoff |
| Run marker `status: running` | Block second launch for same issue |
| Worker heartbeat | Worker updates `run_id` lease in state comment every **30 min** while active |
| Stale reclaim | Reclaim **only** when the recorded run is **terminal** (completed/failed/cancelled per Cursor/Claude API) **or** the heartbeat lease is expired **and** the run API reports non-running. Fixed wall-clock alone is insufficient — long legitimate runs may exceed 3h. After reclaim: comment, clear `busy`, assign `KanopeeKa` + `needs-owner` reason `stuck` |

Delivery path check (before implement / execute-plan approve delegation):

1. Parse `agent-paths` from issue body if present (advisory).
2. Independently derive paths from delivery template + branch name.
3. Expand all globs to tracked files; any `isForbiddenPath` hit → `needs-owner` `sensitive-paths` (fail closed if block missing).

## 10. Project sync

| Direction | Writer | PAT |
|-----------|--------|-----|
| Automation → Pawpet Status | Dispatcher tick + thin release helpers (merge/UAT/prod notify call shared `issue_pipeline_project.js`, not ad-hoc handlers) | `GH_PROJECTS_PAT` or fine-grained with Projects |
| Human board drag | Allowed | Reverse sync optional future: webhook handler not in Actions — document as manual or nightly reconcile |

**Migration:** remove direct `updateProjectStatus` from legacy paths or delegate them to the shared module so automated transitions do not double-write conflicting Status values.

Status option names must match live Pawpet field (case-insensitive match in scripts). **Done / In Prod** are board options only — not `status:*` repo labels.

## 11. Observability

- Each tick: summary comment optional (suppress in `on` mode; verbose in `dry-run`).
- Structured log in Actions: `issue`, `action`, `lane`, `assignee`, `dry_run`.
- Metrics debt: count ticks, worker failures, mean time in column (future).

## 12. Secrets and environments

| Secret | Consumer |
|--------|----------|
| `EXECUTE_PLAN_BOT_TOKEN` | `pawpet-bot` assign/write/handoff |
| `PAWPET_CLAUDE_TOKEN` | Claude handoffs and issue write |
| `GH_PROJECTS_PAT` | Status field |
| `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID` | Project v2 API |
| `CURSOR_API_KEY` | Cursor launches |
| `OWNER_GH_TOKEN` | **Not** mounted in dispatcher jobs |

Environment: `automation` (same as current agent dispatch).

## 13. Testing strategy

| Phase | Test |
|-------|------|
| Skeleton | `ISSUE_PIPELINE=dry-run` on fixture issues; assert logged actions |
| Triage | Unit tests on extracted triage functions |
| Handoff | Integration: assign bot A → expect assigned event → dry-run tick → assign bot B |
| WIP | Three Ready issues, `WIP_MAX=2` → only two implement actions; one active light-plan issue + one Ready `PR` issue → the PR still launches |
| Exclusion | `manual-only` issue in To do assigned `pawpet-claude` → no action logged |
| Convergence | Green + body edit after an earlier Green → reassigned to the other agent, not Ready |
| E2E | Single test issue through dry-run then controlled `on` on a sandbox label `pipeline-e2e` |

## 14. Migration from live workflow

| Step | Action |
|------|--------|
| 1 | Ship dispatcher `dry-run` parallel to existing workflows |
| 2 | Enable triage-at-To-do for issues with label `pipeline-beta` |
| 3 | Flip `ISSUE_PIPELINE=on`; legacy workflows skip when `vars.ISSUE_PIPELINE == 'on'` (`triage-human-reviewed.yml`, `agent-dispatch.yml`, `agent-monitor.yml`) |
| 4 | Remove `Agent1:*` / `Agent2:*` labels from open issues |
| 5 | Update `github-issue-workflow.md` to target model; archive `human-reviewed` gate description |
| 6 | Consolidate Pawpet Status updates: merge/UAT/prod notify use shared project helper; drop duplicate `GH_PROJECTS_PAT` bindings where redundant |