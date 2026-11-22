---
title: Pipeline v2 soak2 findings (sign-off)
owner: Agent efficiency
audience: owner
status: in-delivery
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, soak]
related_prs: [2510, 2511, 2512, 2517, 2525]
---

# Soak2 sign-off — findings and recommended fixes (2026-11-22)

Soak2 exercised **pipeline-beta** fixtures **#2493–#2508** under live ticks. Canonical decisions: [`github-issue-workflow.md`](../github-issue-workflow.md) (PIPE-V2-D-SOAK-006–008, PIPE-V2-D-PREFLIGHT-001, PIPE-V2-D-RUNNER-001, and **Proposed** SOAK-003–005). There is **no** `pipeline-v2-soak2-matrix.md` on `main` (matrix lived only on unmerged **PR #2509**).

---

## Executive summary

| Area | Result |
|------|--------|
| **Preflight (Out of scope)** | **Fixed #2517** — validated on post-merge ticks. |
| **Runner / queue** | **#2510–#2512** shipped; round robin and Claude **`queued`** observed. |
| **Happy path To do → Done** | **Not proven.** Best case **#2493** reached **In Main** ([#2522](https://github.com/AgathaTrack/AgathaTrack/pull/2522) merged); **In UAT / Done never exercised.** |
| **Matrix row completion** | **Partial.** Many Ready issues sat in **`ready.queued`** (WIP cap). Several deliveries were **in flight when fixtures were closed** (see [Teardown](#teardown-2026-11-22)). |
| **Open product findings** | **#2506-class** in-scope acceptance keywords still **`launch-failed`**; **#2495** escalation delivery **unproven** on a clean fixture. |

**Recommendation:** Merge engine fixes on `main`. Run **soak3** on a **small, new fixture set** (new matrix proposal under `changes/` only until accepted). See [§Soak playbook](../github-issue-workflow.md#pipeline-v2-the-stage-machine) in the canonical doc.

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

## Outcome matrix (honest final)

Legend: **Pass** = expectation met in soak2. **Open** = gap or workaround. **Unproven** = not observed. **N/A** = retired before completion.

| # | Fixture | Expected | Observed (at teardown) | Verdict | Notes / suggested fix |
|---|---------|----------|------------------------|---------|------------------------|
| #2493 | E2E → **Done** | Full stage path | **In Main** only ([#2522](https://github.com/AgathaTrack/AgathaTrack/pull/2522)); closed before UAT/Done | **Unproven** | Soak3: one E2E row, minimal parallelism, prove **In UAT → Done** |
| #2494 | Question / no DoD | Block | **`blocked`** (question) | **Pass** | Reuse as soak3 control |
| #2495 | SOAK-008 escalation | Delivery → **`Blocked=decision`**, no PR, truthful Security | Analysis converged **Ready** with **Security: Yes**; delivery escalation **not run**. Body **operator-reset** during soak | **Unproven** | **Fresh soak3 fixture** only. Gate: agent sets **`Blocked=decision`** + comment; **no** body edit to evade preflight; **no** delivery launch until owner clears |
| #2496 | Paused | Skip | **`blocked.paused`** | **Pass** | SOAK-005 still **Proposed** — confirm paused-not-woken in soak3 |
| #2497 | Claude runner | Docs delivery | **In Main** after [#2515](https://github.com/AgathaTrack/AgathaTrack/pull/2515) merged + DoD + operator `finish-work` | **Pass** (delivery) | Earlier **`progress.stalled`** without DoD — see canonical soak playbook |
| #2498 | Docs + rotation | Launch, merge | **In progress** at close; open [#2523](https://github.com/AgathaTrack/AgathaTrack/pull/2523) | **N/A** | Teardown closed issue before merge; PR may complete without pipeline advance |
| #2499 | Rotation C | Launch | **In progress** at close; **no open PR** found | **N/A** | Incomplete |
| #2500 | No-convergence | Owner path | **`analysis.reassign`** | **Unproven** | Soak3 row |
| #2501 | WIP filler A | Queue / deliver | **In progress** at close; open [#2524](https://github.com/AgathaTrack/AgathaTrack/pull/2524) | **N/A** | Orphan delivery like #2498 |
| #2502 | WIP filler B | Queue | **`ready.queued`** pattern | **Pass** (queue) | Tied to **PIPE-V2-D-SOAK-003** (**Proposed**) |
| #2503 | manual-only | No writes | skip | **Pass** | |
| #2504 | Forbidden | Refuse launch | **`launch-failed`** | **Pass** | |
| #2505 | Feature DoR | Delivery | **In Main** after [#2516](https://github.com/AgathaTrack/AgathaTrack/pull/2516) + DoD | **Pass** (delivery) | |
| #2506 | Bug DoR | Docs PR | **`launch-failed`** (auth/billing in **Acceptance criteria**); operator **reworded body** to launch | **Open** | **Not an engine pass.** Operator workaround parallels forbidden agent body edits (SOAK-008). **Open finding:** in-scope acceptance prose still trips preflight — product scan change or fixture-only negation under **Out of scope** |
| #2507 / #2508 | Post-#2517 launch | Docs PR | **`ready.queued`**; no dedicated **`launch:`** log before close | **Unproven** | Soak3 regression guard for preflight |
| — | Round robin | Spread agents | After **#2510** | **Pass** | |
| — | Claude **`queued`** | Cap behaviour | After **#2512** | **Pass** | |
| — | Preflight OOS | Ignore OOS keywords | After **#2517** | **Pass** | |

---

## Open findings (need soak3 or product work)

| ID | Finding | Suggested fix |
|----|---------|---------------|
| SOAK2-F-001 | **E2E To do → Done** never completed | Soak3 gate on a single fixture; see playbook (DoD, intent, AAT) |
| SOAK2-F-002 | **In-scope acceptance keywords** (`#2506`) | Engine still scans acceptance criteria; operator reword is not a pass — accept as limitation or extend preflight section rules (lower priority than **#2517**) |
| SOAK2-F-003 | **Escalation delivery** (`Blocked=decision`) | New fixture; concrete pass criteria in [Soak3 gates](#soak3-gates-proposed) |
| SOAK2-F-004 | **Premature fixture teardown** | Closed issues while [#2523](https://github.com/AgathaTrack/AgathaTrack/pull/2523) / [#2524](https://github.com/AgathaTrack/AgathaTrack/pull/2524) open; do not repeat — drain or `WIP_LIMIT=off`, then close |

---

## Shipped on `main` (soak2 motivation)

| PR | Outcome |
|----|---------|
| **#2510** | Board-wide round robin (PIPE-V2-D-SOAK-006) |
| **#2511** | SOAK-007/008 docs + spec/review skills |
| **#2512** | Claude runner WIP + **`queued`** (PIPE-V2-D-RUNNER-001) |
| **#2517** | Out-of-scope excluded from preflight (PIPE-V2-D-PREFLIGHT-001) |

---

## Decision log rows still **Proposed** (not validated in soak2)

| ID | Claim | Soak2 evidence | Soak3 |
|----|-------|----------------|-------|
| **PIPE-V2-D-SOAK-003** | WIP counts only **In progress** with an engine launch record (hand-driven **In progress** does not consume cap) | **`ready.queued`** when cap full; plausible match — **not formally proven** | Design test: hand-driven vs engine **In progress** on cap |
| **PIPE-V2-D-SOAK-004** | `busy` doorbell gets one extra timeout before reassign | **Untested** | Optional doorbell timeout fixture |
| **PIPE-V2-D-SOAK-005** | **`Blocked=paused`** never woken by comment | **#2496** skip only — wake path **untested** | Paused + comment tick |

Accepted soak2 rows: **SOAK-006**, **SOAK-007**, **SOAK-008** (analysis discipline), **PREFLIGHT-001**, **RUNNER-001** — see canonical decision log.

---

## SOAK-008 and #2495

- **Analysis:** converged **Ready** without agents falsifying **Security or Sensitive Area** (post-**#2511**).
- **Delivery:** **`Blocked=decision`** without PR **not observed**.
- **Fixture integrity:** operator body/`Blocked` reset during soak — **do not reuse #2495** for soak3.

---

## Teardown (2026-11-22)

Issues **#2493–#2508** were **closed** with a sign-off comment so the board could reset for soak3.

**Caveat:** Teardown happened while some deliveries were still active:

| Issue | Delivery state at close | Linked PR |
|-------|-------------------------|-----------|
| #2493 | **In Main** only; never **Done** | #2522 merged |
| #2497 / #2505 | Deliveries had merged (**#2515**, **#2516**) | — |
| #2498 / #2501 | **In progress** | **#2523**, **#2524** **open** |

Closing parent issues does not cancel agent runs; merged PRs on closed issues may not advance **Stage**. Treat **#2523** / **#2524** as orphan soak2 deliveries unless manually reconciled.

Soak1 (**#2480–#2487**) was already closed. **#2385** remains the pipeline v2 tracking issue.

---

## Soak3 gates (proposed)

Move to canonical §Soak when the owner accepts; until then this list is the proposal:

1. **E2E Done** — one sandbox issue **To do → Done** (intent + AAT if enabled).
2. **Preflight launch** — one docs issue whose risky words live only under **Out of scope** → **`launch:`** without `launch-failed` (**#2507/#2508** class).
3. **Escalation** — **new** issue, **Security: Yes**, AGENTS escalation: delivery sets **`Blocked=decision`**, removes **`busy`**, **no PR**, body unchanged.
4. **#2506 class** — either prove **`launch-failed`** on in-scope keywords (**Open**) or ship a scan change and re-test.
5. **SOAK-003** — optional WIP cap experiment (engine vs hand **In progress**).
6. **SOAK-004 / SOAK-005** — optional unless prioritised.

New fixtures only; new matrix file under `docs/agent-efficiency/changes/` as **proposal** until folded into `github-issue-workflow.md`.

---

## Not recommended

- Inferring **`Blocked=decision`** in the engine from **Security: Yes** alone.
- Reopening soak2 issues — use soak3 fixtures instead.