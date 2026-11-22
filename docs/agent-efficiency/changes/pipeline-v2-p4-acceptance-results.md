---
title: Pipeline v2 P4 acceptance dry-run results
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, review, p4]
---

# P4 acceptance: `decideRound` dry-run over beta issues

Dry-run acceptance for **PIPE-V2-D-REV3-007** ([review process v3](./pipeline-v2-review-process-v3.md)). Compares the P4 round plan (`planRounds` / `decideRound`) with the live `decide()` action on Pawpet beta issues. **No GitHub writes** — `ISSUE_PIPELINE_V2=dry-run`, scoped with `pipeline-beta`.

## 1. Run metadata

| Field | Value |
|-------|--------|
| Date (UTC) | 2026-11-22 |
| Branch | `claude/stoic-tesla-jr66ho` |
| Commit | `734763601fd37209e3a84b6682e93a45799ac273` |
| Node | v22.23.4 |
| `PIPELINE_VOTE_KEY` set | **No** (verdicts not visible; plans treat open review runs as silent retries) |
| `ISSUE_PIPELINE_V2` | `dry-run` |
| `ISSUE_PIPELINE_V2_LABEL` | `pipeline-beta` |
| Board issues in scope (tick) | 46 |
| In analysis + `v2:review-request` (beta) | **6** |
| Unit tests (`node --test scripts/issue_pipeline_v2*.test.js`) | **243 pass, 0 fail** |
| Raw log | [`p4-acceptance-dry-run.jsonl`](./p4-acceptance-dry-run.jsonl) (repo-relative) |
| Stderr | empty |
| Log shape | No line with `writes: true`. Summary `pipeline_v2_tick` with `mode: "dry-run"` is the **last** line (per-issue `pipeline_v2_action` / `pipeline_v2_round_plan` lines precede it). |

Second identical tick ([stability check G](#3-checks-a-h)) wrote `/tmp/p4-acceptance-run2.jsonl` (not committed; 13 404 bytes; plans matched run 1).

## 2. In analysis issues (round plan vs live)

| Issue | Stage | Review requests (`v2:review-request`) | Live action (row) | Live agent | Plan type | Round | Tier | Plan agent | Fallback | Attempt | Agreement | Notes |
|------:|-------|--------------------------------------:|-------------------|------------|-----------|-------|------|------------|----------|--------:|-----------|-------|
| 2527 | In analysis | 1 | `analysis.reassign` | `claude-a` | `request-round` | R2 | a | `claude-a` | false | 2 | agree | Live timeout reassign; plan `analysis.round-retry` same identity |
| 2530 | In analysis | 2 | `analysis.reassign` | `cursor-a` | `request-round` | R3 | a | `cursor-a` | false | 2 | agree | R3 matches two review requests |
| 2531 | In analysis | 1 | `analysis.reassign` | `cursor-a` | `request-round` | R2 | a | `cursor-a` | **true** | 2 | agree | Retry after silent `claude-a`; `fallback=true` (same-brand repeat) |
| 2532 | In analysis | 1 | `analysis.reassign` | `claude-a` | `request-round` | R2 | a | `claude-a` | false | 2 | agree | |
| 2533 | In analysis | 1 | `analysis.reassign` | `cursor-a` | `request-round` | R2 | a | `cursor-a` | false | 2 | agree | Live `failureClass: not-startable` |
| 2534 | In analysis | 2 | `analysis.reassign` | `claude-a` | `request-round` | R3 | a | `cursor-a` | false | 2 | **disagree** | Plan alternation / retry picks `cursor-a`; live legacy reassign keeps `claude-a` |

## 3. Checks (A–H)

| Check | Result | Evidence |
|-------|--------|----------|
| **A** Coverage | **pass** | All 6 beta **In analysis** issues with ≥1 `v2:review-request` have a `pipeline_v2_round_plan` line (#2527–2534). Issues #1673, #2056, #2301, #2302, #2405 log `analysis.request` but are not In analysis and/or have no review-request comments — n.a. for round plan. |
| **B** No error | **pass** | Tick `errors: []`; no `pipeline_v2_error`; no `plan.error` on round-plan lines. |
| **C** Tier discipline | **pass** | Every `request-round` with `tier: a` uses `cursor-a` or `claude-a` only (#2527–2534). No tier-b rounds on the board. |
| **D** Round labels | **pass** | R2/R3 align with review-request count (1→R2, 2→R3). See log `reviews` on each `pipeline_v2_round_plan`. |
| **E** Retry semantics | **pass** | All plans use `attempt: 2`; retry agent ≠ silent holder on the open round (#2531: silent `claude-a`, plan `cursor-a`). `fallback: true` only on #2531 where same-brand repeat is required. |
| **F** Agreement with live | **pass with expected disagreements** | 5/6 agree on identity (`reassign` vs `request-round` is immaterial). **1 disagreement** — #2534 (below). |
| **G** Stability | **pass** | Second dry-run produced identical `pipeline_v2_round_plan` JSON for all six issues. |
| **H** Known limits | **n.a. (noted)** | No `PIPELINE_VOTE_KEY` — no signed verdicts in facts (H). Attempt start = request time; `lastUsed` per issue; no P3 markers consumed yet — per PIPE-V2-D-REV3-007. |

## 4. Disagreements

| Issue | Live | Plan | One-line reason |
|------:|------|------|-----------------|
| 2534 | `reassign` → `claude-a` (`analysis.reassign`, `failureClass: not-startable`) | `request-round` → `cursor-a` (`analysis.round-retry`, R3 attempt 2) | Live engine still uses legacy reassign / holder identity after timeout or not-startable; P4 `decideRound` alternates brand and names `cursor-a` for the silent R3 retry. |

## 5. Verdict

**P4 acceptance (first dry-run, as written above): PASS WITH DISAGREEMENTS. Superseded by the review in §7: not accepted; re-run required.**

The round planner covers every beta In analysis issue that has review requests, produces consistent tier-a R2/R3 retries with no plan errors, and is stable across repeated ticks. One expected identity disagreement (#2534) shows where live `decide()` has not yet adopted P4 reassign semantics. `PIPELINE_VOTE_KEY` was absent; verdict-driven branches were not exercised (documented limit, not a run failure).

## 6. Raw log

Committed at [`docs/agent-efficiency/changes/p4-acceptance-dry-run.jsonl`](./p4-acceptance-dry-run.jsonl) (13 404 bytes).

## 7. Review of this run (Claude)

**Verdict: not accepted. Re-run required.** The run is useful, but three things in §2 to §5 do not hold as written.

1. **Five agreements overstate the result.** Without `PIPELINE_VOTE_KEY`, no verdict is visible, so a body that a red edit produced is attributed to a human. With a human author the plan's alternation has no brand to avoid and falls back to least-recently-used. That happens to match the live round robin on #2527, #2530, #2532 and #2533. These are coincidences, not evidence that the round rule agrees with the live engine.
2. **A real bug in `decideRound`, found in §2.** A round holder outside the tier pool (a tier-b id on a tier-a round, or one that cannot be started) was waited on until `reviewTimeoutMin`. REV3-004 says it is reassigned at once, and the live engine does that (`failureClass: not-startable`). #2533 and #2534 hit this path. **Fixed in the code that follows this review:** a holder outside the tier pool is a silent attempt at once, with `reason: not-startable`. A test covers it. The suite is at 244 passing.
3. **The #2534 cause is not "live has not adopted P4".** The plan saw R2 (`cursor-b`) and R3 (`claude-b`) with no verdicts, so it could not see the red that moved the body from `da18…` to `a5a2…`. It then treated the body as human-authored and fell back to least-recently-used (`cursor-a`). The live engine reassigned the non-pool holder to `claude-a`. The first is a derivation gap without the key; the second is the bug in point 2. The policy difference left is least-recently-used per issue (plan) against the board-wide round robin (live). That difference is listed as a known limit in REV3-007.

**What holds:** coverage of the six issues, no errors, no `writes: true`, tier-a discipline, round labels for R2 and R3, retry excludes the silent holder, and `fallback: true` on #2531. Stability was checked on one repeat tick.

**To accept P4:** re-run this acceptance on a branch at or after REV3-010 (verdicts from comments, no vote key). Pass when (a) the non-pool holder cases show `not-startable` at once, (b) any identity disagreement has a cause in the table, and (c) at least one issue shows a visible red-with-edit with claim and verdict, so authorship is tested. See [`pipeline-v2-p4-acceptance-rerun.md`](./pipeline-v2-p4-acceptance-rerun.md) when the re-run lands.

