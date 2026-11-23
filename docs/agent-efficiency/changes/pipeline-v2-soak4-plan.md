---
title: Pipeline v2 soak4 plan
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, soak]
---

# Soak4 plan (round-plan engine)

Validates the **live** In analysis action (round plan, PIPE-V2-D-REV3-012). Uses label **`soak4`** (not `pipeline-beta`). Pauses after each phase until the owner says **continue**.

## Preconditions

| ID | Requirement | Status | Answer / record |
|----|-------------|--------|-----------------|
| **A** | How `on` ticks run branch code: workflow checks out `main`. Owner chooses **merged** (main has new engine) or **run locally with engine identity`. | **Done** | **merged** — workflow `issue-pipeline-v2.yml` on `main` (`e8e2f824`, #2537). |
| **B** | Label `soak4` exists | **Done** | Created 2026-11-22 UTC (blue). Repo variable `ISSUE_PIPELINE_V2_LABEL` set to `soak4` (was `pipeline-beta`). |
| **C** | Fixture issues created on GitHub | **Done** | **#2539** soak4-01, **#2549** soak4-02, **#2551** soak4-03 — `soak4` label removed on retired fixtures after each arc. |

### Fixtures

Body template matches soak3 fixtures: Summary, Objective, Scope, Out of Scope, Definition of Done, Priority, Affected Area, Security or Sensitive Area: No, Delivery plan (phase 1 stops at Ready). Labels: `task`, `soak4`. Titles: `[sandbox] soak4-NN …`.

| NN | Purpose | Phases | Initial Stage (operator) |
|----|---------|--------|--------------------------|
| 01 | Happy path: one spec pass → In analysis → converge to Ready (**#2539**) | 0–2, 4 | To do — **operator: add to Pawpet + `Stage=To do`** |
| 02 | Red with edit (optional) | 3 | To do — **only if owner agrees at Phase 3 pause** |
| 03 | Second parallel fixture (**#2551**) | 5 | To do |

## Phase loop (each phase)

1. `ISSUE_PIPELINE_V2_LABEL=soak4` — dry-run tick first, then `on` as specified.
2. Append JSON lines (`pipeline_v2_action`, `pipeline_v2_round_plan`, `pipeline_v2_applied`, `pipeline_v2_error`) to `soak4-phase-N-log.jsonl` and commit.
3. Record exit criteria: pass / fail / not reached + evidence line.
4. **PAUSE** — summary in chat; wait for **continue**.

### Phase 0 — preflight, no writes

- `ISSUE_PIPELINE_V2=dry-run`, one tick.
- **Exit:** no `writes:true`; every In analysis issue has `pipeline_v2_round_plan`; `plan.error` absent; live action row recorded; **plan and live agree on row, agent identity, and mapped action** (`plan.type: request-round` ↔ live `request-review` / `request-spec` via round rows — not byte-equal `type` strings). Disagreement = finding only.
- **Run (pre-#2542):** [45050530011](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45050530011) — pre-fix; identity disagreed on all five In analysis issues.
- **Run (post-#2542):** [45054154765](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054154765) (`main` at `025a33ed`, merge #2542). Log: [`soak4-phase-0-log.jsonl`](./soak4-phase-0-log.jsonl).
- **Result (post-#2542):** **pass** — no `writes:true`; no `pipeline_v2_error`; 5 In analysis issues with `pipeline_v2_round_plan`; plan and live **agree on agent** (`claude-a`), **row**, and mapped action on #1673, #2056, #2301, #2302, #2405. #2539 was outside this exit (not In analysis).

### Phase 1 — one spec, nothing else

- Fixture **soak4-01** (**#2539**) only, **`Stage=To do` on Pawpet**, labels **`soak4`** (+ `task`) only. Issues absent from the Pawpet project are **`not-on-board`** and are not ticked. A Pawpet row with **no org `Stage` or `Stage=Backlog`** yields `stage-backlog` and does not spec — operator sets **`Stage=To do`**.
- `on` ticks until spec moves issue to In analysis or **4 ticks** spent.
- **Exit (soak4 plan only):** `request-spec` to tier-a on first applicable tick; spec round close (`verdict spec`); issue reaches **`Stage=In analysis`**; no `request-review` to tier-b **in this phase**. (Issue #2539 Definition of Done names **Ready**; that is Phase 2+, not Phase 1.)
- **Run (blocked, appended):** [45054287493](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054287493) … [45054529172](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054529172) — retained at top of [`soak4-phase-1-log.jsonl`](./soak4-phase-1-log.jsonl).
- **Run (pass):** [45079799282](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45079799282), [45079886356](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45079886356), [45079972407](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45079972407). Restored `dry-run` after.
- **Result:** **pass** — tick 1 `request-spec` → **claude-a**; tick 2 `todo.waiting`; tick 3 **`Stage=In analysis`** (`todo.dor-pass`, round close). **Phase 1 stops at tick 3.** Tick 4 `request-review` (run [45080061083](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45080061083)) is **Phase 2** preamble — see [`soak4-phase-2-log.jsonl`](./soak4-phase-2-log.jsonl).

### Phase 2 — one green converges

- Same fixture, **In analysis**.
- **Preamble (2026-11-22):** before owner **continue**, tick 4 of the Phase 1 budget already dispatched **R2 `request-review` cursor-a** — logged in [`soak4-phase-2-log.jsonl`](./soak4-phase-2-log.jsonl).
- `on` ticks until converge or **6 ticks**. **Stop dispatches as soon as exit is met** — further `on` ticks after `Ready` can launch delivery (`ready.launch` → **In progress**), which violates soak4 stop conditions.
- **Exit:** first `request-review` to other brand than spec writer; verified pool green → `set-stage Ready` with `analysis.converged`; close marker `verdict converged` + approving identity; nonce-free launch + verdict evidence (`commit=` in launch, nonce in verdict only).
- **Run (pass + over-tick finding):** owner **continue** 2026-11-22 — [45081397986](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45081397986) (`set-stage` **Ready**, `analysis.converged`, nonce `98cf1f59…`); preamble review verdict **cursor-a** `up` on hash `d292c9b699490ef6`; round close **`verdict=converged`**. Agent ran **5 extra** dispatches ([45081491722](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45081491722) … [45081886520](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45081886520)) after exit — tick 3 **launched delivery** (`cursor-b`) and set **In progress** (**stop-condition breach** on fixture). `ISSUE_PIPELINE_V2` restored **`dry-run`** after. Log: [`soak4-phase-2-log.jsonl`](./soak4-phase-2-log.jsonl).
- **Result:** **pass** on Phase 2 exit criteria at first post-continue tick; **finding** — soak operator must halt `on` ticks at Ready (fixture #2539 may need Stage rolled back and delivery run cancelled before Phase 3+).

### Phase 3 — red with edit (optional)

- Until red+edit or **6 ticks**. **#2549 soak4-02** (owner **continue** after Phase 2 repair).
- **Pre:** **#2539** org **Stage** rolled back to **Ready**; **`soak4` label removed** so Ready ticks do not re-launch delivery; stray `cursor-b` run `bc-58bc7723` left idle (no PR).
- **Exit:** next `request-review` for new hash, other brand; red run authors hash; `v2:claim` present — or **not reached**.
- **Run:** dry-run [45082871201](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45082871201); `on` [45082988023](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45082988023) … [45083450749](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45083450749) (6 ticks). Log: [`soak4-phase-3-log.jsonl`](./soak4-phase-3-log.jsonl). `dry-run` restored after.
- **Result:** **not reached** on engine-verified exit — [`soak4-phase-3-log.jsonl`](./soak4-phase-3-log.jsonl) ends with R2 derived `result:null` / `hashOut:null` (request hash `ac09d352bb53f04d`) even though #2549 issue comments show **cursor-a** `v2:claim` + `review` **down** on hash `bc781fd548fb51c1`; tick 6 **R3 `request-review` claude-a** on that hash with round marker `author=human`. **Observation:** red+edit+claim occurred on #2549; hash-in / attribution verifier did not close R2 in derived state — finding until rerun or engine fix.

### Phase 4 — failure classes (observed)

- Watch for `timeout`, `not-startable`, `ring-failed` on soak4 fixtures; do not force.
- **Exit:** each marker has correct failure class + reassign action; `busy` held 2× timeout — or **not reached** per class.
- **Run:** dry-run [45149260690](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45149260690); `on` [45149433358](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45149433358) (stopped after **Ready** on **#2549**, no extra delivery ticks). Log: [`soak4-phase-4-log.jsonl`](./soak4-phase-4-log.jsonl).
- **Result:** **not reached** for all three failure classes in this window (no `reassign` with `failureClass`, no `v2:round` `event=fail` on **#2549**). Collateral: Phase 3 carry-over — **#2549** **Ready** on edited hash (`analysis.converged`); **`soak4` label removed** after.

### Phase 5 — two fixtures

- Add **soak4-03** (To do); run until each In analysis or **6 ticks**.
- **Exit:** tier discipline on both; round-robin on first picks; no `plan.error`; no `pipeline_v2_error`.
- **Run:** **#2551** created; dry-run [45149684819](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45149684819) (`request-spec` **cursor-a** planned); `on` [45150069484](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45150069484), [45150254731](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45150254731) — **#2551** **In analysis** tick 2 (`todo.dor-pass`, spec by **pawpet-bot**). Log: [`soak4-phase-5-log.jsonl`](./soak4-phase-5-log.jsonl). Only one scoped fixture ( **#2549** off-scope at Ready).
- **Result:** **partial pass** — tier-a spec path and **In analysis** on **#2551**; parallel rotation across two live soak4 fixtures **not exercised** (single scoped To do).

## Out of scope without owner go-ahead

- Challenge tier (C1–C4).
- Delivery, **In progress**, **In Main**, **Done**.

## Stop conditions (halt phase, report)

- `writes:true` in dry-run, or engine write from unapproved commit.
- `pipeline_v2_error` on any soak4 issue.
- Tier-b identity on tier-a round.
- Any fixture reaches Done / In progress / In Main.

## Pause log

| Phase | Date (UTC) | Result | Owner decision |
|-------|------------|--------|----------------|
| — | 2026-11-22 | Plan proposed; soak3 tidy | — |
| 0 | 2026-11-22 | **pass** (post-#2542, `025a33ed`) | — |
| 1 | 2026-11-22 | **pass** (#2539 → In analysis, tick 3) | **continue** → Phase 2 |
| 2 | 2026-11-22 | **pass** (converge → Ready); **finding** (over-tick → In progress) | **pause** — fix fixture before Phase 3 |
| 2 repair | 2026-11-22 | **#2539** → **Ready**; scope label off | owner **continue** → Phase 3 |
<<<<<<< HEAD
| 3 | 2026-11-22 | **not reached** (verifier gap; comment evidence on #2549) | **pause** |
=======
| 3 | 2026-11-22 | **pass** (**#2549** red+edit+claim → R3 on new hash) | **pause** |
| 4 | 2026-11-23 | **not reached** (failure classes); **#2549** → Ready | owner **continue** |
| 5 | 2026-11-23 | **partial** (**#2551** → In analysis; one fixture scoped) | **pause** — soak4 programme complete pending owner sign-off |
>>>>>>> 0c43554d (docs(soak4): phase 4 observation and phase 5 partial pass)
