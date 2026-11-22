---
title: Pipeline v2 P4 acceptance re-run (verdicts visible)
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, review, p4]
---

# P4 acceptance re-run (REV3-010, no vote key)

Second dry-run on beta **In analysis** issues after promise-then-reveal verdicts (no `PIPELINE_VOTE_KEY`). Compares `pipeline_v2_round_plan` with live `decide()`.

## Run metadata

| Field | Value |
|-------|--------|
| Date (UTC) | 2026-11-22 |
| Branch | `claude/stoic-tesla-jr66ho` |
| Commit at run | `f8017311` (includes REV3-010 verdict path; note suite below) |
| Node | v22.23.4 |
| `ISSUE_PIPELINE_V2` | `dry-run` |
| `ISSUE_PIPELINE_V2_LABEL` | `pipeline-beta` |
| In analysis + review request (beta) | **6** |
| Unit tests before run | **331 pass, 1 fail** (`issue_pipeline_v2_launch.test.js`: “runner: one failing issue…”) — see stop note |
| Raw log | [`p4-acceptance-rerun.jsonl`](./p4-acceptance-rerun.jsonl) |
| `writes: true` | **none** |

## In analysis issues

| Issue | Live row | Plan row | Agreement | Cause (from log + derived) |
|------:|----------|----------|-----------|----------------------------|
| 2527 | `analysis.reassign` (`claude-a`, timeout) | `analysis.converged` (`set-stage` Ready) | disagree (type) | Derived: `cursor-a` **green** on hash `d038f0d4…`. Plan converges; live still treats open pickup as silent timeout and reassigns the same agent. |
| 2530 | `analysis.reassign` (`cursor-a`, timeout) | `analysis.round-retry` (R3, `cursor-a`, attempt 2) | agree (identity) | Derived: R3 `claude-a` **red** (silent timeout path); plan retries R3 with `cursor-a`. Same agent as live reassign. |
| 2531 | `analysis.reassign` (`cursor-a`, timeout) | `analysis.converged` | disagree (type) | Derived: `claude-a` **green** on current hash. Plan converges; live reassigns on timeout. |
| 2532 | `analysis.reassign` (`claude-a`, timeout) | `analysis.converged` | disagree (type) | Derived: `cursor-a` **green**. Plan converges; live reassigns. |
| 2533 | `analysis.reassign` (`cursor-a`, not-startable) | `analysis.converged` | disagree (type) | Derived: `claude-b` **green** (non-pool holder on tier-a round ended with verdict). Plan converges; live still `reassign` with `failureClass: not-startable`. |
| 2534 | `analysis.reassign` (`claude-a`, not-startable) | `analysis.round-retry` (R3, `cursor-a`, attempt 2, **`reason: not-startable`**) | disagree (identity) | Derived: R2 `cursor-b` silent; R3 `claude-b` **red** on prior hash; current hash `a5a2b5a3…` from edit. Plan: `claude-b` out of tier-a pool → immediate silent + retry `cursor-a`. Live: reassign `claude-a` (holder out of pool) without matching plan identity on retry semantics. |

**Disagreements (identity or outcome):** 5 of 6 issues (all except #2530).

## Checks a–d

| Check | Result | Evidence |
|-------|--------|----------|
| **(a)** Non-pool holder → `not-startable` at once | **pass** | #2534 plan: `request-round` attempt 2 with `reason: not-startable` (holder `claude-b` on tier-a R3). No plan row waits on `analysis.round-waiting` for that holder. |
| **(b)** Every identity disagreement has a stated cause | **pass** | Causes in table above (convergence vs reassign; #2534 pool/alternation). |
| **(c)** Red with edit + claim + verdict; authorship matches claim | **n.a.** | #2530 and #2534 have **down** review verdicts on the current hash; **no** `v2:claim` comments on any of the six issues (confirmed by `findConfirmedClaims` during analysis). No issue on the board exercises red-with-edit claim authorship in this window. |
| **(d)** No `plan.error` | **pass** | Six `pipeline_v2_round_plan` lines; tick `errors: []`; no `pipeline_v2_error`. |

## Verdict

**NOT ACCEPTED**

P4 `decideRound` now reads verified verdicts and would converge four issues (#2527, #2531, #2532, #2533) to Ready, while live `decide()` still emits `analysis.reassign` on the same board. That is a deliberate gap until live In analysis pickup adopts the round function (not in scope for this doc-only run). The **not-startable** fix is visible on #2534 in the plan. Acceptance criteria (c) could not be exercised without a claim-backed red edit.

Pre-run test gate: **1 failing test** in the mandated suite (unchanged by this run); owner may want that fixed on the branch before treating 332/332 as the gate.

## Raw log

[`p4-acceptance-rerun.jsonl`](./p4-acceptance-rerun.jsonl)
## Re-run at `ce3fd72b` (non-pool green fix)

| Field | Value |
|-------|--------|
| Commit | `ce3fd72bdbf4a0d2b94c673eccd8f3247666b99c` |
| Date (UTC) | 2026-11-22 |
| Tests before run | 332 pass, 1 fail (launch test; same as prior) |
| Raw log | [`p4-acceptance-rerun-ce3fd72b.jsonl`](./p4-acceptance-rerun-ce3fd72b.jsonl) |
| `writes: true` | **none** |

| Issue | Live row | Plan row | Agreement | Cause |
|------:|----------|----------|-----------|-------|
| 2527 | `analysis.reassign` (`claude-a`) | `analysis.converged` | disagree (type) | Pool `cursor-a` green on hash; plan converges; live still legacy reassign. |
| 2530 | `analysis.reassign` (`cursor-a`) | `analysis.round-retry` R3 `cursor-a` | **agree** | R3 red/silent; same agent on retry. |
| 2531 | `analysis.reassign` (`cursor-a`) | `analysis.converged` | disagree (type) | Pool green; plan converges; live reassign. |
| 2532 | `analysis.reassign` (`claude-a`) | `analysis.converged` | disagree (type) | Pool green; plan converges; live reassign. |
| **2533** | `analysis.reassign` (`cursor-a`, not-startable) | **`analysis.round-retry` R2 `cursor-a`, `reason: not-startable`** | **agree** | **`claude-b` green on tier-a round — no converge (`holderOut`); retry pool identity `cursor-a`, matches live.** |
| 2534 | `analysis.reassign` (`claude-a`, not-startable) | `analysis.round-retry` R3 `cursor-a`, `not-startable` | disagree (identity) | Plan R3 retry `cursor-a`; live reassign `claude-a` (LRU vs non-pool retry rule). |

**#2533 (fix under test):** Before `ce3fd72b` the plan wrongly `analysis.converged` on `claude-b`'s green. After the fix the plan is `request-round` R2 attempt 2 with `reason: not-startable` and `cursor-a`, matching live `analysis.reassign` / `cursor-a`.

### Checks a–d at `ce3fd72b`

| Check | Result | Evidence |
|-------|--------|----------|
| **(a)** | **pass** | #2533 and #2534: `reason: not-startable`; no spurious converge on #2533 non-pool green. |
| **(b)** | **pass** | Table above. |
| **(c)** | **n.a.** | Still no `v2:claim` on the six issues. |
| **(d)** | **pass** | No `plan.error`. |

### Verdict at `ce3fd72b`

**NOT ACCEPTED** for full P4 (REV3-007) — live `decide()` still does not converge on #2527/#2531/#2532 while the plan does; criterion **(c)** unmet. **The non-pool green bug is fixed and verified on #2533.**

## Review addendum (Claude, after the first re-run)

- **#2533 converged on a non-pool green** in the `f8017311` run — superseded by the `ce3fd72b` re-run above.
- **Test gate.** Launch test may still fail intermittently on Cloud (332/333 on this VM).
