---
title: Issue pipeline — dispatcher specification
owner: Documentation Team
audience: agent
status: proposed
status_since: 2026-11-14
last_updated: 2026-11-14
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
| `scripts/issue_pipeline_state.js` | Parse/update `<!-- agent-state: … -->` |
| `scripts/issue_pipeline_project.js` | Pawpet Status read/write (wraps `github_issue_workflow.js` patterns) |
| `scripts/issue_pipeline_workers/` | Launch Claude action or Cursor API per lane |
| Repo variable `ISSUE_PIPELINE` | `off` \| `dry-run` \| `on` |

**Retire when parity reached:** `triage-human-reviewed.yml`, `agent-dispatch.yml`, `agent-monitor.yml` (or thin wrappers that call dispatcher only).

## 2. Triggers

| Event | Use |
|-------|-----|
| `issues: assigned` | Primary — start lane for new assignee |
| `issues: labeled`, `issues: edited` | Secondary — delivery labels, `question` cleared |
| `issue_comment` (allowlisted authors) | Re-queue intake after author answers |
| `pull_request_target: closed` (merged) | Release tracking, WIP slot free |
| `workflow_run` (deploy-uat, deploy-prod, CI) | UAT/Prod notify alignment |
| `schedule` (30 min) | Heartbeat — match execute-plan driver |
| `workflow_dispatch` | `dry_run`, optional `issue_number`, force tick |

**Not used:** Project v2 item events (not available as workflow triggers).

## 3. Tick algorithm

1. If `ISSUE_PIPELINE` is `off`, exit 0.
2. Load org/project field IDs from secrets (`GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, org `AgathaTrack`).
3. For each open issue with label ∉ {support-only exclusions}:
   - Read Pawpet **Status**, **assignee**, delivery labels, `busy`, `needs-owner`, `manual-only`, state block.
   - Compute **eligible action** at most one per issue (priority table below).
4. Sort actions by priority label then issue age.
5. Apply **lane caps**; skip if cap reached.
6. If `dry-run`, log planned actions only.
7. Else execute: set lock (`busy` / marker), call worker or deterministic script, update assignee/status with **bot PAT** (not `GITHUB_TOKEN` for handoffs).

### 3.1 Action priority (per issue)

| Order | Condition | Action |
|-------|-----------|--------|
| 1 | `needs-owner` + assignee `KanopeeKa` | None (wait for human) |
| 2 | Status To do + assignee `pawpet-claude` + no `question` | Triage then intake worker |
| 3 | Status In Analysis + assignee ∈ bots | Review worker |
| 4 | Status Ready + assignee `pawpet-bot` + no delivery label | Delivery worker |
| 5 | Status Ready + delivery label + unassigned + WIP slot | Implement launch |
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
  issues where Status = "In progress"
    AND assignee.login = "pawpet-bot"
    AND has label busy
) + programme_weight(active light-plan | execute-plan sessions)
```

| Config | Default |
|--------|---------|
| `WIP_MAX` | 2 |
| Programme weight | light-plan session = 1 slot; execute-plan active = 1 slot |

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
| Triage | manual-only | — | In Analysis or Backlog per policy |
| Intake | need info | author | Backlog + `question` |
| Intake | ok | `pawpet-bot` | In Analysis |
| Review | red / green+edits | other bot | In Analysis |
| Review | green, converged | `pawpet-bot` | Ready |
| Review | round > cap | `KanopeeKa` | + `needs-owner` |
| Delivery | ok | *none* | Ready + delivery label |
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
- Outputs: pass → continue intake; fail → Backlog + `question`; `manual-only` → stop automation.

**Deprecate:** requiring `human-reviewed` for Ready dispatch. Optional: humans add `human-reviewed` only when moving Backlog → To do as audit trail — not read by dispatcher except as optional flag.

## 8. Workers

### 8.1 Claude (intake, review when assignee `pawpet-claude`)

- Runner: `anthropics/claude-code-action` or equivalent workflow job.
- Trigger: `workflow_call` from dispatcher with `issue_number`, `lane`, `dry_run`.
- Token: `PAWPET_CLAUDE_TOKEN` or job token if sufficient for assign/write.
- Output: comment (verdict text), body edits, state block update, assign other bot or advance via PAT callback step.

### 8.2 Cursor (review when `pawpet-bot`, delivery, implement, monitor)

- Reuse `launch-cursor-agent.js`, `monitor-cursor-agent.js`, `agent-payload-lib.js`.
- Model policy: implement lane Composer 2.5 per `pr-review-cost-efficiency.md` cloud policy.
- Run marker: `<!-- cursor-agent-run: {"id":"…","status":"running",…} -->` (existing pattern).

## 9. Locks and staleness

| Mechanism | Rule |
|-----------|------|
| `busy` | Set on implement/monitor launch; removed on merge or explicit handoff |
| Run marker `status: running` | Block second launch for same issue |
| Stale reclaim | No heartbeat from worker for **3h** (analysis) or **6h** (implement) → comment, clear lock, assign `KanopeeKa` + `needs-owner` reason `stuck` |

## 10. Project sync

| Direction | Writer | PAT |
|-----------|--------|-----|
| Automation → Pawpet Status | Dispatcher / workers | `GH_PROJECTS_PAT` or fine-grained with Projects |
| Human board drag | Allowed | Reverse sync optional future: webhook handler not in Actions — document as manual or nightly reconcile |

Status option names must match live Pawpet field (case-insensitive match in scripts).

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
| WIP | Three Ready issues, `WIP_MAX=2` → only two implement actions |
| E2E | Single test issue through dry-run then controlled `on` on a sandbox label `pipeline-e2e` |

## 14. Migration from live workflow

| Step | Action |
|------|--------|
| 1 | Ship dispatcher `dry-run` parallel to existing workflows |
| 2 | Enable triage-at-To-do for issues with label `pipeline-beta` |
| 3 | Flip `ISSUE_PIPELINE=on`; disable `agent-approved` trigger on old dispatch |
| 4 | Remove `Agent1:*` / `Agent2:*` labels from open issues |
| 5 | Update `github-issue-workflow.md` to target model; archive `human-reviewed` gate description |