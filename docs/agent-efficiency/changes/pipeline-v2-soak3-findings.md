---
title: Pipeline v3 soak3 phase 1 findings
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, soak]
related_prs: []
---

# Soak3 phase 1 findings (To do → Ready)

Matrix: [pipeline-v2-soak3-matrix.md](./pipeline-v2-soak3-matrix.md). Fixtures **#2527–#2535**.

Raw tick log: `/opt/cursor/artifacts/soak3-tick-log.txt` (also commit path when PR updates).

## Prep (2026-11-22)

| Step | Status |
|------|--------|
| `Stage=To do` #2527–#2535 | API PATCH |
| `Blocked=paused` #2529 only | Done |
| `Blocked` cleared on others | `blocked: null` write |
| `ISSUE_PIPELINE_V2` | **`dry-run`** after each burst |
| `ISSUE_PIPELINE_V2_LABEL` | `pipeline-beta` |

---

## Tick runs

| # | Mode | Run ID |
|---|------|--------|
| 0 | dry-run | [45015921797](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45015921797) |
| 1 | on | [45016003734](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45016003734) |
| 2 | on | [45016348363](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45016348363) |
| 3 | on | [45016644356](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45016644356) |
| 4 | on | [45017005236](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45017005236) |
| 5 | on | [45017331373](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45017331373) |
| 6 | on | [45017614764](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45017614764) |

Cadence: ~2.5 min per `on` tick + **150 s** between bursts for doorbells. **No** `ready.launch` / delivery in any run (`wip=0`).

---

## Per-fixture outcome (after tick 6)

| Issue | Fixture | Expected (phase 1) | Stage | Blocked | Engine rows observed | Verdict |
|-------|---------|-------------------|-------|---------|----------------------|---------|
| #2527 | soak3-01 happy | **Ready** | **In analysis** | — | `todo.request` → `todo.dor-pass` → `analysis.request`; then **`analysis.waiting`** | **Partial** — spec + 1× `review up`; not converged |
| #2528 | soak3-02 question | **question** | **To do** | **question** | `todo.request`; tick 2+ **`blocked`** | **Pass** |
| #2529 | soak3-03 paused | skip | **To do** | **paused** | **`blocked.paused`** every tick | **Pass** |
| #2530 | soak3-04 round robin | **Ready** | **In analysis** | — | spec pass; `analysis.request`; **`analysis.waiting`**; 1× `review down` | **Partial** |
| #2531 | soak3-05 claude spec | **Ready** | **In analysis** | — | `todo.request` **cursor-a** (not Claude); spec pass; 1× `review up` | **Partial** — wrong agent on *first* spec ring vs title intent |
| #2532 | soak3-06 SOAK-007 | **Ready** | **In analysis** | — | late `todo.dor-pass` (tick 3); 1× `review up` | **Partial** — dry-run between ticks used; not tested to Ready |
| #2533 | soak3-07 two ids | **Ready** | **In analysis** | — | spec pass; 1× `review up` from **claude-b** | **Partial** — need 2nd distinct id |
| #2534 | soak3-08 no-convergence | **no-convergence** | **In analysis** | — | tick 1 **`runner-queued:claude-b`**; adversarial **edit** + extra review rings; still waiting | **In progress** — cap not hit in 6 ticks |
| #2535 | soak3-09 manual-only | skip | **To do** | — | **`manual-only`** every tick | **Pass** |

---

## What works

| Area | Evidence | Notes |
|------|----------|--------|
| **Board field setup** | All fixtures **To do**; #2529 **paused** | Org field PATCH with `blocked: null` clears Blocked |
| **Label gate** | Only `pipeline-beta` issues get spec/review actions | #2535 excluded |
| **Paused skip** | #2529 `blocked.paused` with **no** `applied` | SOAK-005 skip path |
| **Question path** | #2528 **`Blocked=question`**, stays **To do**, engine **`blocked`** | DoR `no-checkbox` + spec agent |
| **Spec → In analysis** | #2527, #2530–#2534 `todo.dor-pass` after signed spec | `busy` cleared on stage move |
| **Round robin (assignment)** | Tick 0/1 distinct agents per virgin issue (cursor-b, claude-a, …) | Consistent with SOAK-006 |
| **Claude runner queue** | #2534 tick 1 `runner-queued:claude-b` → tick 2 `ring-doorbell` | RUNNER-001 behaviour |
| **No delivery in phase 1** | No `ready.launch` in 6 ticks | Phase boundary respected |

---

## What does not (yet) / gaps

| Gap | Root cause | Suggested fix |
|-----|------------|---------------|
| **None reached Ready** in 6 ticks | **Real time:** review doorbells need agent turns; most issues at **`analysis.waiting`** with 0–1 signed `review up` (need 2 for human-edited bodies or 1 for lone agent editor). **Cadence:** 150 s gap may be short for Claude/Cursor doorbells. | Run **3–6 more `on` ticks** with longer gaps (5–10 min) or fewer parallel fixtures; optionally test **one** happy-path issue in isolation (`WIP_LIMIT=off` does not apply to analysis). |
| **#2531 “Claude spec” fixture** | First `todo.request` on #2531 was **cursor-a** (round robin), not Claude. Fixture title is misleading — ring order is board-wide, not per-row intent. | Rename fixture to “observe ring pick” or file issues **sequentially** so #2531 is the only virgin issue when testing Claude. |
| **SOAK-007 (#2532)** not proven | Reviews landed during **`dry-run`** between ticks, but **Ready** not reached within window — same convergence delay. | After reviews complete, confirm **`analysis.converged`** only on first **`on`** tick after dry-run stall (explicit tick pair). |
| **#2534 no-convergence** | Adversarial agent added body **edit** votes and signed reviews; **6 votes** not reached yet. Cursor shared-login note in comments (reactions don’t count). | Continue ticks on #2534 only; expect **`analysis.no-convergence`** or document agent playbook for signed downs. |
| **Parallel spec load** | Eight simultaneous `todo.request` on tick 1 stressed runners (#2534 queued). | Phase 1: **stagger** fixture creation or reset Stage in waves of 2–3 issues. |

---

## Recommended pause actions (before more ticks)

1. Keep **`ISSUE_PIPELINE_V2=dry-run`** (done).
2. **Do not** clear **`busy`** on in-analysis issues — let review agents finish.
3. **Fixtures to watch next:** #2527 (needs 2nd reviewer), #2533 (two-id convergence), #2534 (cap).
4. **#2528:** owner comment with target line when testing wake from **question**.
5. **#2529:** clear **`Blocked=paused`** when re-enabled for a later row.

---

## Phase 1 stop criteria

Per matrix: stop when each row is **Ready** or expected **blocked**. After 6 ticks: **3/9 pass**, **5/9 partial**, **1/9 in progress** (#2534). **Enough information** to pause and tune cadence/fixture parallelism before chasing Ready on all rows.