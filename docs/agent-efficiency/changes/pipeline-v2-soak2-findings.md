---
title: Pipeline v2 soak2 findings (sign-off)
owner: Agent efficiency
audience: owner
status: complete
last_updated: 2026-11-22
tags: [agent, pipeline, soak]
related_prs: [2510, 2511, 2512, 2517, 2518]
---

# Soak2 sign-off — findings and recommended fixes (2026-11-22)

Soak2 exercised the **pipeline-beta** fixture set (**#2493–#2508**) under live ticks. This document is the wrap-up; canonical decisions live in [`github-issue-workflow.md`](../github-issue-workflow.md) (PIPE-V2-D-SOAK-006–008, PIPE-V2-D-PREFLIGHT-001, PIPE-V2-D-RUNNER-001). **All soak2 fixtures were closed on 2026-11-22** so a fresh matrix can be filed for soak3.

---

## Executive summary

| Area | Result |
|------|--------|
| **Production defect (preflight)** | **Fixed #2517** — keywords under `### Out of scope` no longer trip `detectRiskyScope`. Validated on live ticks after merge. |
| **Runner / WIP** | **Fixed #2510–#2512** — board round robin, Claude runner WIP + `queued` label behaviour observed as designed. |
| **Engine semantics** | Mostly **correct**; gaps were **operator/fixture** (DoD checkboxes, `finish-work`) or **agent discipline** (#2495 escalation), not tick bugs. |
| **Matrix completion** | **Partial** — WIP cap and parallel deliveries meant several Ready fixtures never reached `launch:` in this round; not enough evidence to block cutover decisions. |

**Recommendation:** Ship preflight and runner fixes on `main`; treat soak3 as a **clean fixture set** with explicit pass/fail per row, shorter WIP contention (merge fillers first or `WIP_LIMIT=off` during drain-only windows).

---

## Live tick windows (reference)

| Window | `ISSUE_PIPELINE_V2` | Notable runs |
|--------|---------------------|--------------|
| Initial soak | `on` ~16:44–17:01 UTC 2026-11-21 | 44926171197 · 44926895355 · 44927399610 |
| Post-#2510–#2512 | `on` ~21:27–22:05 UTC | 44951660909 · 44952597885 · 44954818042 |
| Post-#2517 preflight | `on` ~23:01 UTC | 44959762695 |
| WIP queue | `on` ~23:21 UTC | 44961334156 · 44961477565 |
| WIP drain + launch | `on` ~10:12–10:31 UTC 2026-11-22 | [45011561354](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45011561354) · [45012436899](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45012436899) · [45012772613](https://github.com/AgathaTrack/AgathaTrack/actions/runs/45012772613) |

Repo left in **`dry-run`** after each burst.

---

## Outcome matrix (final)

| # | Fixture | Expected | Observed (final) | Root cause | Suggested fix |
|---|---------|----------|------------------|------------|---------------|
| #2493 | E2E happy path | To do → **Done** | **In Main** after [#2522](https://github.com/AgathaTrack/AgathaTrack/pull/2522); intent/UAT/Done **not completed** in this round | WIP contention + operator had to check DoD / `finish-work` for `progress.finished` | **Soak3:** single E2E fixture with `WIP_LIMIT=off` or no parallel fillers; document operator step in soak playbook |
| #2494 | Question / no DoD | Skip / block | **`blocked`** (question path) | — | **Pass** — keep as soak3 control |
| #2495 | SOAK-008 decision | Delivery → **`Blocked=decision`**, no PR | Analysis converged to **Ready** with **Security: Yes** intact (good). Delivery **`Blocked=decision`** **not observed** (stuck behind WIP) | Engine does not infer `Blocked=decision`; delivery agent must set it | **No engine change.** **Soak3:** dedicate one tick with WIP free; reinforce **#2511** spec/review skills. Optional: triage doc note for operators |
| #2496 | Paused | Skip | **`blocked.paused`** | — | **Pass** |
| #2497 | Claude runner | claude-a delivery | **In Main** after DoD + merged [#2515](https://github.com/AgathaTrack/AgathaTrack/pull/2515) | Earlier **`progress.stalled`** when `busy` cleared without DoD | **Soak playbook:** merge + check DoD before `finish-work` |
| #2498 | Rotation B + docs | Launch after #2517 | **In progress** (delivery running); PR not merged in round | WIP + agent latency | **Soak3** re-run |
| #2499 | Rotation C | Launch | **In progress** (cursor-a acked) | Queued until WIP freed | **Pass** queue semantics |
| #2500 | No-convergence | Adversarial review path | **`analysis.reassign`** (in flight) | — | **Soak3** re-run |
| #2501/#2502 | WIP fillers | Queue when cap=2 | **#2501 In progress**; **#2502** queued | Cap works | **Pass**; soak3 use 0–1 filler issues |
| #2503 | manual-only | No engine writes | **`manual-only`** skip | — | **Pass** |
| #2504 | Forbidden path | Refuse launch | **`launch-failed`** (secrets + Security **Yes**) | Intentional | **Pass** |
| #2505 | Feature DoR | Delivery | **In Main** after [#2516](https://github.com/AgathaTrack/AgathaTrack/pull/2516) + DoD | Same stall lesson as #2497 | **Soak playbook** |
| #2506 | Bug DoR | Docs PR | **`launch-failed`** (auth/billing in **Acceptance criteria** prose) | Keywords in **in-scope** text | **Fixture:** move negation examples to **Out of scope** or reword. **Optional product:** narrow risky sections (lower priority than #2517) |
| #2507/#2508 | Post-#2517 launch | Docs PR | **`ready.queued`** until 2026-11-22; never got a dedicated launch row in logs | WIP full (**#2493/2498/2499/2501**) | **Soak3:** first-class rows; confirm **`launch:`** without `launch-failed` (preflight regression guard) |
| — | Round robin | Spread agents | **Pass** after **#2510** | — | **Shipped** |
| — | Claude `queued` | Backoff + label | **Pass** after **#2512** | — | **Shipped** |
| — | Preflight OOS | Ignore Out of scope keywords | **Pass** after **#2517** on tick 44959762695+ | Whole-body scan bug | **Shipped** |

---

## Recommended fixes (prioritized)

### Shipped on `main` (no further code required)

| PR | Outcome |
|----|---------|
| **#2510** | Board-wide round robin (PIPE-V2-D-SOAK-006) |
| **#2511** | SOAK-007/008 docs + spec/review agent gates |
| **#2512** | Claude runner WIP + `queued` label (PIPE-V2-D-RUNNER-001) |
| **#2517** | Out-of-scope excluded from preflight keyword scan (PIPE-V2-D-PREFLIGHT-001) |

### Process / soak playbook (no PR unless you want a skill)

1. **`progress.finished` requires** merged linked PR, open PR count 0, DoD all `[x]`, and no `busy`. **`finish-work` without DoD** → **`Blocked=stalled`** after resume — treat as operator error, not engine bug.
2. **Live ticks vs `dry-run`:** signed reviews and merges between ticks apply on the **next `on`** tick (PIPE-V2-D-SOAK-007) — plan soak windows accordingly.
3. **WIP=2** with many Ready fixtures produces long **`ready.queued`** — use **`WIP_LIMIT=off`** only for controlled drain/soak slices, or serialize fillers.
4. **#2495 / escalation:** delivery agent must **`Blocked=decision`** + recommendation comment; engine will not set it from the plan alone.

### Optional follow-ups (product / debt)

| Item | Suggestion |
|------|------------|
| **#2506-class false positives** | Keep scanning in-scope acceptance text; write soak bodies with risky words only under **Out of scope** or use neutral wording |
| **#2509 matrix doc** | Merge or replace when soak3 matrix is written (proposed matrix was never on `main`) |
| **#2513 / #2514** | Runner/preflight debt called out during soak — triage separately if still open |
| **Operator doc** | One paragraph in §Soak of `github-issue-workflow.md` (added 2026-11-22) for DoD + WIP drain |

### Not recommended

- **Inferring `Blocked=decision` in the engine** from Security **Yes** alone — would bypass deliberate agent escalation workflow.
- **More live ticking on closed #2493–#2508** — fixtures retired; use soak3.

---

## SOAK-008 (#2495) note

Spec/review agents must **not** edit **Security or Sensitive Area** or scope to evade preflight. This round **passed** at analysis (converged **Ready** with **Security: Yes**). End-to-end **delivery → `Blocked=decision`** remains **unproven** and should be the **first soak3 gate** on a single issue.

---

## Teardown (2026-11-22)

Closed as **soak2 complete / fixtures retired** (not product delivery):

**#2493 #2494 #2495 #2496 #2497 #2498 #2499 #2500 #2501 #2502 #2503 #2504 #2505 #2506 #2507 #2508**

Soak1 sandbox issues (**#2480–#2487**) were already closed. Tracking issue **#2385** remains open.

**Starting soak3:** new issues, new `pipeline-beta` label set, updated matrix under `docs/agent-efficiency/changes/` when ready; keep `ISSUE_PIPELINE_V2=dry-run` until the matrix is reviewed.

---

## Unvalidated in soak2 (carry to soak3)

- **#2493** → **In UAT** → **Done** (intent doorbell + AAT if enabled).
- **#2507 / #2508** — post-#2517 **`launch:`** success.
- **#2495** — delivery **`Blocked=decision`** without PR.
- **#2500** — **`no-convergence`** owner path.
- Round-robin spot-check with three concurrent spec pickups on clean issues.