---
title: Pipeline v2 soak3 closure record
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, soak]
---

# Soak3 closure tidy-up (2026-11-22 UTC)

Soak3 fixtures exercised the superseded review model. The live In analysis action is the round plan (PIPE-V2-D-REV3-012). Soak4 starts from new fixtures.

## Inventory (read-only, 2026-11-22 UTC)

### Issues titled `[sandbox] soak3-*`

| # | State (at inventory) | Title | Labels | busy / queued / manual-only |
|---|----------------------|-------|--------|-----------------------------|
| 2527 | open → **closed** | [sandbox] soak3-01 happy path: To do to Ready (spec+review) | task, busy, pipeline-beta | **busy** |
| 2528 | open → **closed** | [sandbox] soak3-02 question: Definition of Done withheld | task, pipeline-beta | — |
| 2529 | open → **closed** | [sandbox] soak3-03 paused: engine skip | task, pipeline-beta | — |
| 2530 | open → **closed** | [sandbox] soak3-04 round robin: first spec pickup | task, busy, pipeline-beta | **busy** |
| 2531 | open → **closed** | [sandbox] soak3-05 claude spec doorbell | task, busy, pipeline-beta | **busy** |
| 2532 | open → **closed** | [sandbox] soak3-06 dry-run review lag (SOAK-007) | task, busy, pipeline-beta | **busy** |
| 2533 | open → **closed** | [sandbox] soak3-07 two distinct reviewers | task, busy, pipeline-beta | **busy** |
| 2534 | open → **closed** | [sandbox] soak3-08 no-convergence cap | task, busy, pipeline-beta | **busy** |
| 2535 | open → **closed** | [sandbox] soak3-09 control: manual-only | task, manual-only, pipeline-beta | **manual-only** |

No issue carried a `queued` label at inventory time.

### Pull requests mentioning soak3

| # | State | Title / head |
|---|-------|----------------|
| 2536 | closed (not merged) | Soak3 phase 1: To do→Ready matrix and fixture bootstrap |
| 2537 | closed (merged) | Pipeline v2 tier-a / rounds / keyless verdicts — **out of scope for this agent** |

No **open** PRs mention soak3 (expected).

### Remote branches containing `soak3`

| Branch | Notes |
|--------|--------|
| `cursor/soak3-todo-ready-b790` | Retained (no deletion) |

### `main` soak3 artifacts

| Check | Result |
|-------|--------|
| `scripts/bootstrap_soak3_phase1_issues.sh` | **Absent** on `main` (PR #2536 closed without merge) |
| `docs/agent-efficiency/changes/pipeline-v2-soak3-*` | **Absent** on `main` |

### Project board (org `Stage`)

No project write token in this session. At inventory via issue org fields, several fixtures were **not Done** (e.g. #2527 **In analysis**; others **To do** / **question** / **paused** per soak3 matrix). **No board fields were changed** during tidy-up; closed issues may still show non-Done Stage until the owner clears them.

## Closed issues (this tidy-up)

#2527, #2528, #2529, #2530, #2531, #2532, #2533, #2534, #2535 — each received the soak3 closure comment, then `state_reason: not_planned`. Labels unchanged.

## Left open

None with the `[sandbox] soak3-` title prefix.

## Owner decisions

1. **Branch** `cursor/soak3-todo-ready-b790` — merge, cherry-pick, or archive the soak3 findings doc (`docs/agent-efficiency/changes/pipeline-v2-soak3-findings.md` on that branch only).
2. **Board** — non-Done Stage rows for closed soak3 fixtures (if still visible).
3. **Unmerged PR #2536** — close already done; no `main` bootstrap/matrix unless reopened deliberately.