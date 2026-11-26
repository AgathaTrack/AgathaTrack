---
title: Github Labels
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-18
tags: [agent-efficiency, policy]
---
# GitHub labels — autonomous workflows

Labels for `/execute-plan`, `/babysit-plus`, and debt tracking. Create in repo settings if missing (document-only in Phase A).

---

## Plan control issue

| Label | Purpose |
|-------|---------|
| `execute-plan` | Marks plan control issues |
| `plan:<plan_id>` | e.g. `plan:foster-card-split` |
| `autonomous-approved` | Autonomy granted; agent may run |
| `autonomous-revoked` | Halt — remove `autonomous-approved` when revoking |
| `autonomous-resumed` | Optional — human acknowledged resume |

### Control issue title

```
[execute-plan] <plan_id>
```

### Control issue body (template)

```markdown
## Plan
- **ID:** <plan_id>
- **Snapshot:** `.agents/plans/<plan_id>.snapshot.json`
- **Content hash:** sha256:…
- **Approved until:** <ISO-8601 UTC> (48h default)

## Phases
| ID | Title | Merge mode | Status |
|----|-------|------------|--------|
| 1 | … | auto | pending |

## Revoke
Add label `autonomous-revoked` (halt only — does not close PRs).

## Resume
Remove revoke label; comment `resume-plan <plan_id>`.
```

---

## Issue pipeline programmes

| Label | Purpose |
|-------|---------|
| `owner-programme` | Owner-applied only. A standing programme issue (for example `light-plan:` #2342) whose phase/release PRs may use `/run-as-me` when the session opts in. Bots never add this label. Confirm the `labeled` event actor is an owner in `.github/execute-plan.config.json` → `owners` before relying on it — see [run-as-me skill](../../.cursor/skills/run-as-me/SKILL.md). |
| `light-plan` | Sequential programme; tracking issue uses a `light-plan:` title and phase checklist |
| `pipeline-beta` | Soak sandbox for pipeline v2 (`ISSUE_PIPELINE_V2_LABEL` scopes live writes in `on` mode). Clear the variable for whole-board cutover. Open issues titled `[sandbox] soak2-*` that carry this label are v2 fixtures, not product backlog. |
| `owner-approved-delivery` | Owner only. Ready delivery: after the owner clears `Blocked=sensitive` on a legacy launch-failed hold, lets the launch through (the v2 launch no longer runs the keyword scan, PIPE-V2-D-REV4-004). |
| `analyse-only` | Set by the `/analyse-issue` orchestrator at intake. The issue stops at Ready on every tick. Removing it is the owner's decision to let the general pipeline launch delivery (PIPE-V2-D-ANALYSE-004). |
| `delivery-issue` | Set only when the owner invokes `/delivery-issue`. Marks an owner-held delivery orchestrator run. Engine-launched delivery (including AAT scope relaunch) never sets it. Removed at Done or a human hold (PIPE-V2-D-DELIVER-002). |
| `queued` | Pipeline v2: Claude doorbell deferred at runner WIP cap; `ring-doorbell` retries until pickup timeout, then reassign; cleared on successful launch, doorbell failure, or `finish-work` |

---

## Pull request labels

| Label | Purpose |
|-------|---------|
| `do-not-merge` | Babysit+ and execute-plan skip merge |
| `merge-lease` | Mutex — one PR holds the merge slot while babysit+ runs §7 merge coordination ([autonomous-pr-policy.md](./autonomous-pr-policy.md) §Merge coordination). Create in repo settings if missing. |
| `snag` | Optional — trivial follow-up micro-PR (see [atomic-pr-policy.md](./atomic-pr-policy.md)) |

---

## E2E remedial (`/e2e-debug`)

| Label | Purpose |
|-------|---------|
| `e2e-debug` | Marks the control issue for an active pre-UAT remedial session (create in repo settings if missing) |
| `busy` | Combined with `e2e-debug` — another agent is orchestrating remedial work (preflight blocks) |

**Preflight:** `node scripts/e2e_debug_status.mjs --json` before bootstrap. **Claim:** `--claim --issue <n>` · **Release:** `--release --issue <n>` when handing off to `/babysit-uat`.

---

## UAT coordinator (cross-agent queue)

| Label | Purpose |
|-------|---------|
| `uat-coordinator` | Marks the pinned `[uat-coordinator] UAT deploy queue` issue |

**Bootstrap:** create the coordination issue, pin it, set `UAT_COORDINATION_ISSUE=<n>` in repo Actions variables (and locally for CLI `--write`). Runbook: [uat-coordinator-bootstrap.md](./uat-coordinator-bootstrap.md). Ledger CLI: `scripts/uat_queue_runtime.js` — see [uat-coordinator-plan.md](./uat-coordinator-plan.md).

| Label | Purpose |
|-------|---------|
| `agent-uat-fix` | Optional — triggers UAT coordinator agent dispatch (Phase 3) |

---

## Agent acceptance (`/AgentAcceptance`)

| Label | Purpose |
|-------|---------|
| `AAT-progress` | AAT run in progress — set by `aat-start` |
| `AAT-passed` | Holistic acceptance passed — issue may close when policy allows |
| `AAT-failed` | Acceptance failed — remediation PR or P0 sub-issue required |

**Marker (authoritative for automation):** last line of the verdict comment — `<!-- v2:aat verdict=pass|fail|inconclusive merge=<sha> -->` (appended by the CLI). A fail includes the reason: `<!-- v2:aat verdict=fail reason=scope|implementation|quality merge=<sha> -->`. Pass and inconclusive omit `reason`. Attribute order does not matter.

**CLI:** `node scripts/github_issue_workflow.js aat-start|aat-pass|aat-fail|aat-inconclusive --issue <n> [--merge <sha>]`. `aat-fail` requires `--reason scope|implementation|quality` and exits non-zero without it.  
Labels and comments use the GitHub REST API (`createGitHubClient`); `aat-start` ensures repo labels via REST when missing. Set `GH_TOKEN` (Cursor / pawpet-bot) or `PAWPET_CLAUDE_TOKEN` (Claude Code) before running — not a stale workflow `GITHUB_TOKEN` alone.  
**Procedure:** [`.cursor/skills/agent-acceptance/SKILL.md`](../../.cursor/skills/agent-acceptance/SKILL.md)

Do not run AAT on issues whose body contains `<!-- v2:follow-up of=#… -->`.

---

## Pipeline soak

| Label | Purpose |
|-------|---------|
| `pipeline-beta` | Fixture receives live pipeline v2 writes when `ISSUE_PIPELINE_V2_LABEL` matches (existing soak scope) |
| `soak-box` | Rolling batch issue listing deferred catalog soaks ([soak-testing.md](./soak-testing.md)) |
| `soak-human` | Catalog spec requires a human step; agents must not claim an agent-runnable Pass without that step done |

Labels **`soak-box`** and **`soak-human`** exist in the repo. Catalog specs default to **agent-runnable**; add `soak-human` on the fixture when not.

---

## Debt / review follow-up issues

| Label | Purpose |
|-------|---------|
| `tech-debt` | Deferred improvement |
| `review-follow-up` | Originated from PR review triage |
| `plan:<plan_id>` | Links to execute-plan run |

### Issue title format

```
[tech-debt] <short description> (plan:<plan_id> phase:<n>)
```

Batched nits:

```
[tech-debt] Nits in <file> (PR #<n>)
```

---

## Dedupe search

Before creating a debt issue:

```bash
gh issue list --label "review-follow-up" --label "tech-debt" --search "<plan_id> <file_path>" --state all --limit 20
```

Match on dedupe key (see [autonomous-pr-policy.md](./autonomous-pr-policy.md) §Debt issues). Comment on existing issue if key matches.

---

## Comment keywords (control issue)

| Comment | Meaning |
|---------|---------|
| `approve-autonomous <plan_id>` | (Usually in agent chat) Grants autonomy |
| `resume-plan <plan_id>` | Human acknowledges resume |
| `accept-head` | Acknowledge PR force-push; agent may update `pr_head_sha` |

---

## Project status (control issue)

Per `docs/agent-efficiency/github-issue-workflow.md`. **Cloud Agents do not write the Project `Status` field** — use comments + `busy`; `Stage` follows the who-writes-what table in that doc. Debt issues get `start-work` only when picked up.

| Stage | Agent action |
|-------|----------------|
| `init-control-issue` / `gh issue create` | Create issue (board **Backlog** is human/Actions) |
| First work session after `gate` passes | `start-work` — comment + `busy` |
| `complete-plan --write` (all phases merged) | Close with summary comment |

**Agent CLI helpers:**

```bash
node scripts/github_issue_workflow.js start-work --issue <n> --body "…"
node scripts/github_issue_workflow.js finish-work --issue <n>   # remove `busy` (e.g. intent review done)
node scripts/github_issue_workflow.js comment --issue <n> --body "…"
```

Pause/halt/complete: prefer `--post-comment` on `pause`, `halt`, `resume-uat`, and `complete-plan`.

`set-project-status` exists for GitHub Actions / local ops with `GH_PROJECTS_PAT` — agents skip it.
