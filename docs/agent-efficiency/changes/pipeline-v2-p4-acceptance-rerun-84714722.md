---
title: Pipeline v2 P4 acceptance re-run at 84714722
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/changes/pipeline-v2-p4-acceptance-rerun.md
last_updated: 2026-11-22
tags: [agent, pipeline, review, p4]
---

# P4 acceptance re-run at `84714722`

Dry-run of `issue_pipeline_v2.js` on beta **In analysis** issues with at least one `v2:review-request`. Compares `pipeline_v2_round_plan` with live `pipeline_v2_action` (`decide()`).

## Run metadata

| Field | Value |
|-------|--------|
| Date (UTC) | 2026-11-22 |
| Branch | `claude/stoic-tesla-jr66ho` |
| Commit (full SHA) | `84714722525e1c0409ab639a4e3637d7dacf74ff` |
| Node | v22.23.4 |
| Unit tests before run | **333 pass, 0 fail** (`scripts/issue_pipeline*.test.js`, `scripts/pipeline_claude*.test.js`, `scripts/pipeline_runners/*.test.js`) |
| Env (names only) | `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `GH_PROJECTS_PAT`, `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, `ISSUE_PIPELINE_V2=dry-run`, `ISSUE_PIPELINE_V2_LABEL=pipeline-beta` (no `PIPELINE_VOTE_KEY`) |
| In analysis + plan row | **6** |
| Tick `issueCount` | 47 |
| Stderr | empty |
| `writes: true` | **none** (0 matches in log) |
| Final tick | `pipeline_v2_tick`, `mode: dry-run`, `errors: []` |
| Raw log | [`p4-acceptance-rerun-84714722.jsonl`](./p4-acceptance-rerun-84714722.jsonl) |

## Per-issue comparison

| Issue | Live row | Plan row | Agreement | Cause |
|------:|----------|----------|-----------|-------|
| 2527 | `analysis.reassign` (`claude-a`, `failureClass: timeout`) | `analysis.converged` (`set-stage` → Ready, approvedBy `cursor-a`) | disagree (type) | **Derived:** tier-a review, `cursor-a` **green** on hash `d038f0d4…`. Plan converges; live legacy pickup still silent-timeout reassigns `claude-a`. |
| 2530 | `analysis.reassign` (`cursor-a`, `timeout`) | `analysis.round-retry` (R3, `cursor-a`, attempt 2) | **agree** (identity + retry outcome) | **Derived:** R3 `claude-a` **red** on hash `9c627090…`; prior R2 `cursor-b` silent. Plan retries R3 with same pool identity as live. |
| 2531 | `analysis.reassign` (`cursor-a`, `timeout`) | `analysis.converged` (approvedBy `claude-a`) | disagree (type) | **Derived:** `claude-a` **green** on `78f14af3…`. Plan converges; live reassign. |
| 2532 | `analysis.reassign` (`claude-a`, `timeout`) | `analysis.converged` (approvedBy `cursor-a`) | disagree (type) | **Derived:** `cursor-a` **green** on `83fab05a…`. Plan converges; live reassign. |
| **2533** | `analysis.reassign` (`cursor-a`, `not-startable`) | **`analysis.round-retry`** (R2, `cursor-a`, attempt 2, **`reason: not-startable`**) | **agree** | **Derived:** `claude-b` **green** on tier-a R2 (non-pool holder); plan does **not** converge; immediate retry with pool `cursor-a`, matching live. |
| 2534 | `analysis.reassign` (`claude-a`, `not-startable`) | `analysis.round-retry` (R3, `cursor-a`, attempt 2, `reason: not-startable`) | disagree (identity) | **Derived:** R3 `claude-b` **red** on `a5a2b5a3…` (non-pool on tier-a). Plan retries with pool `cursor-a`; live LRU reassigns `claude-a`. |

**Identity agreement:** 2 of 6 (#2530, #2533).

**Outcome / type agreement (plan vs live action):** 2 of 6 agree on retry/converge semantics (#2530, #2533); 4 disagree (#2527, #2531, #2532 converge vs reassign; #2534 identity).

## Checks a–e

| Check | Result | Evidence |
|-------|--------|----------|
| **(a)** #2533: no converge on non-pool green | **pass** | Plan is `request-round` R2 with `reason: not-startable` and `agent: cursor-a`, not `analysis.converged`. Holder `claude-b` green in `derived` does not produce Ready. Live `reassign` / `cursor-a` / `not-startable` matches. |
| **(b)** Non-pool holders → `not-startable` immediately | **pass** | #2533 and #2534 plan rows include `reason: not-startable` on first post-verdict decision; no `analysis.round-waiting` for holders `claude-b` off tier-a pool. |
| **(c)** Red + edit + `v2:claim` + `v2:verdict`; plan authorship matches claim | **n.a.** | #2530 and #2534 show **red** in `derived`; no `v2:claim` in tick log or comment scan for any of the six issues. |
| **(d)** No `plan.error` / `pipeline_v2_error` | **pass** | Six `pipeline_v2_round_plan` events; zero `plan.error`; zero `pipeline_v2_error`; tick `errors: []`. |
| **(e)** Identity disagreement causes | **pass** (documented) | Disagreements: #2527 live `claude-a` vs converge evidence `cursor-a`; #2531/#2532 converge vs timeout reassign; #2534 plan `cursor-a` vs live `claude-a` (LRU vs non-pool retry rule). |

## Overall verdict

**NOT ACCEPTED** for full P4 acceptance.

`decideRound` in the plan would converge #2527, #2531, and #2532 to Ready on verified pool greens, while live `decide()` still emits `analysis.reassign` on the same board (known gap: live In analysis pickup does not yet call `decideRound`). Criterion **(c)** is unmet. The **non-pool green** regression on #2533 remains **fixed** at this commit (contrast `f8017311` / pre-`6f7b4bdd` runs).

**Note:** Full acceptance depends on wiring `decideRound` into the live action path (out of scope for this dry-run). Until then, expect plan/live disagreement on pool greens (#2527, #2531, #2532) while `not-startable` behaviour matches on #2533.