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
| **C** | Fixture issues created on GitHub | **Partial** | **#2539** soak4-01 created; soak4-02/03 deferred. |

### Fixtures

Body template matches soak3 fixtures: Summary, Objective, Scope, Out of Scope, Definition of Done, Priority, Affected Area, Security or Sensitive Area: No, Delivery plan (phase 1 stops at Ready). Labels: `task`, `soak4`. Titles: `[sandbox] soak4-NN …`.

| NN | Purpose | Phases | Initial Stage (operator) |
|----|---------|--------|--------------------------|
| 01 | Happy path: one spec pass → In analysis → converge to Ready (**#2539**) | 0–2, 4 | To do — **operator: add to Pawpet + `Stage=To do`** |
| 02 | Red with edit (optional) | 3 | To do — **only if owner agrees at Phase 3 pause** |
| 03 | Second parallel fixture | 5 | To do |

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
- **Exit:** `request-spec` to tier-a (`cursor-a` or `claude-a`) on first tick; spec round close (`verdict spec`); no `request-review` to tier-b.
- **Run:** `ISSUE_PIPELINE_V2=on`, label scope `soak4` — runs [45054287493](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054287493), [45054367168](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054367168), [45054443295](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054443295), [45054529172](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45054529172). Log: [`soak4-phase-1-log.jsonl`](./soak4-phase-1-log.jsonl). `ISSUE_PIPELINE_V2` restored to `dry-run` after.
- **Result:** **not reached** — four ticks logged **`none` / `stage-backlog`** for #2539 (not **To do**); no `request-spec`; no tier-b. **Operator:** confirm Pawpet membership and set **`Stage=To do`** before retry.

### Phase 2 — one green converges

- Same fixture, **In analysis**.
- `on` ticks until converge or **6 ticks**.
- **Exit:** first `request-review` to other brand than spec writer; verified pool green → `set-stage Ready` with `analysis.converged`; close marker `verdict converged` + approving identity; nonce-free launch + verdict evidence (`commit=` in launch, nonce in verdict only).

### Phase 3 — red with edit (optional)

- Until red+edit or **6 ticks**. **soak4-02** only if owner agreed at prior pause.
- **Exit:** next `request-review` for new hash, other brand; red run authors hash; `v2:claim` present — or **not reached**.

### Phase 4 — failure classes (observed)

- Watch for `timeout`, `not-startable`, `ring-failed` on soak4 fixtures; do not force.
- **Exit:** each marker has correct failure class + reassign action; `busy` held 2× timeout — or **not reached** per class.

### Phase 5 — two fixtures

- Add **soak4-03** (To do); run until each In analysis or **6 ticks**.
- **Exit:** tier discipline on both; round-robin on first picks; no `plan.error`; no `pipeline_v2_error`.

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
| 1 | 2026-11-22 | **not reached** (#2539 not on Pawpet) | Add #2539 to Pawpet, **`Stage=To do`**, then **continue** |