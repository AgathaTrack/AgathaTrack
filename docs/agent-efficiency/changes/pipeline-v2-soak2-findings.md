---
title: Pipeline v2 soak2 findings
owner: Agent efficiency
audience: owner
status: active
last_updated: 2026-11-21
tags: [agent, pipeline, soak]
---

# Soak2 findings (2026-11-21)

**Window:** `ISSUE_PIPELINE_V2=on` ~16:44–17:01 UTC; returned to **`dry-run`** at 17:00:50 UTC.  
**Ticks:** [44926171197](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44926171197) Phase A · [44926895355](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44926895355) Phase B · [44927399610](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44927399610) Phase C/D/final.

## Summary

| Result | Count | Fixtures |
|--------|-------|----------|
| **Pass (engine + agent)** | 7 | #2494 question, #2496 paused, #2503 manual-only, #2507 stalled→spec, #2505/#2506 DoR templates, per-issue rotation (#2498/#2499 → `cursor-b` review) |
| **Partial** | 5 | #2493 E2E (In analysis only), #2508 shared-login (review in flight), #2495 decision (agent bypassed block), #2497 Claude (never `claude-a`), #2500/#2504/#2501 WIP (not at target stage yet) |
| **Not exercised** | 4 branches | `ready.queued`, `no-convergence`, `launch-failed`, full E2E→Done, spec/review timeout→`stalled` |

No engine regressions observed on blocked/paused/manual-only or spec→In analysis with signed verdicts.

---

## Per-fixture: expected vs outcome

| ID | Issue | Expected | Outcome | Fix / follow-up |
|----|-------|----------|---------|-----------------|
| soak2-01 | #2493 | To do→Done E2E | **In analysis**; spec signed pass; review not complete | Continue soak when `dry-run`/`on` again; needs merge/UAT/prod path |
| soak2-02 | #2494 | `Blocked=question` | **Pass** — agent asked owner; field `question`; ticks `blocked` | None |
| soak2-03 | #2495 | `Blocked=decision` before delivery | **Fail (agent)** — agent drafted full spec + **spec pass** instead of `Blocked=decision` despite Security section | Tighten spec-agent skill / prompt gate; optional engine lint on `Security or Sensitive Area=Yes` without `Blocked=decision` |
| soak2-04 | #2496 | `blocked.paused` | **Pass** | None |
| soak2-05 | #2497 | Claude doorbell | **Fail (coverage)** — only `cursor-a` spec doorbell; **no** `pipeline-claude-run` in window | Wait 30m reassign to `claude-a` or pre-seed `v2:launch` history; rerun |
| soak2-06/07 | #2498/#2499 | Per-issue LRU | **Pass** — each `cursor-a` spec then **`cursor-b` review** on final tick | None |
| soak2-08 | #2500 | `no-convergence` | **Not reached** — still **To do** (spec doorbell started final tick) | Needs In analysis + adversarial 👎 votes |
| soak2-09/10 | #2501/#2502 | `ready.queued` | **Not reached** — still **To do** + `busy`; #2493 never **In progress** | Run fillers after #2493 delivery launch |
| soak2-11 | #2503 | engine skip | **Pass** `manual-only` | None |
| soak2-12 | #2504 | `launch-failed` | **Not reached** — **To do** spec only | Needs Ready + forbidden `agent-paths` + ~2.5h backoff |
| soak2-13/14 | #2505/#2506 | Feature/bug DoR | **Pass** — **In analysis**, review doorbell `cursor-b` | None |
| soak2-15 | #2507 | clear `Blocked` → `request-spec` | **Pass** — cleared pre-tick; **In analysis** after spec | None |
| soak2-16 | #2508 | Two distinct ids for shared login | **In flight** — `cursor-a` edit+spec; **`cursor-b` review** assigned; not **Ready** yet | Wait for `cursor-b` signed `review` + verify single-id cannot converge alone |

---

## Engine vs agent gaps

1. **`Blocked=decision` (#2495)** — Product rule is agent-set (`spec-agent` SKILL §6). Engine `facts.escalation` is not populated from issue text in the tick reader today; do not expect automatic `any.escalation` without agent `Blocked` write.
2. **Claude runner (#2497)** — First startable agent is always `cursor-a` on a fresh issue; Claude soak needs **timeout/reassign** or **single-agent cursor pool** test config.
3. **Long branches** — `launch-failed`, `no-convergence`, spec exhaustion (~90 min) need **time** or **scripted votes**; not observable in a one-hour window.
4. **WIP (#2501/#2502)** — Matrix precondition (#2493 **In progress**) was not met; fillers only received spec doorbells.
5. **`in-prod` / Done (#2493)** — Not attempted; stub prod policy unchanged (`PROD_DEPLOY_ENABLED` unset).

---

## Recommended next steps

1. Keep **`ISSUE_PIPELINE_V2=dry-run`** until the next coached phase (owner choice).
2. **Debt / agent:** #2495-style fixture + spec-agent enforcement for Sensitive + escalation (issue or skill PR).
3. **Soak resume:** (a) finish #2508 review convergence, (b) drive #2493 toward delivery for WIP test, (c) optional overnight tick for #2497 Claude reassign, (d) schedule #2504 when `launch-failed` is the only goal.
4. Merge matrix doc **#2509** when branch policy allows.