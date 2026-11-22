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

**P4 acceptance: PASS WITH DISAGREEMENTS**

The round planner covers every beta In analysis issue that has review requests, produces consistent tier-a R2/R3 retries with no plan errors, and is stable across repeated ticks. One expected identity disagreement (#2534) shows where live `decide()` has not yet adopted P4 reassign semantics. `PIPELINE_VOTE_KEY` was absent; verdict-driven branches were not exercised (documented limit, not a run failure).

## 6. Raw log

Committed at [`docs/agent-efficiency/changes/p4-acceptance-dry-run.jsonl`](./p4-acceptance-dry-run.jsonl) (13 404 bytes).