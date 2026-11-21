---
title: Pipeline v2 soak2 findings
owner: Agent efficiency
audience: owner
status: active
last_updated: 2026-11-21
tags: [agent, pipeline, soak]
related_prs: []
---

# Soak2 findings and remediation (2026-11-21)

**Window:** `ISSUE_PIPELINE_V2=on` ~16:44–17:01 UTC; returned to **`dry-run`** at 17:00:50 UTC.  
**Ticks:** [Phase A](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44926171197) · [Phase B](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44926895355) · [Phase C/D](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44927399610).

This document lists what the ticks showed, what was wrong, and what we changed (or still need an operator to do).

---

## Issues found during soak ticks

| # | Fixture | What we expected | What happened | Fix |
|---|---------|------------------|---------------|-----|
| — | Round robin | After any assignment, the **next** board pickup is the next startable agent in config order | LRU per issue kept giving **cursor-a** on fresh issues; **claude-a** never ran | **Merged PR #2510** — board-wide ring from newest `v2:launch`; includes closed delivery-column rows (#2510 Copilot follow-up) |
| #2494 | Question path | `Blocked=question`, stay **To do** | **Pass** | None |
| #2496 | Paused | Engine skips while `Blocked=paused` | **Pass** | None |
| #2503 | manual-only | No engine writes | **Pass** | None |
| #2495 | Decision / escalation | Spec agent sets **`Blocked=decision`** before a full spec pass when delivery needs owner on AGENTS.md §Escalation (security/crypto) | Agent **spec-passed** into **In analysis** | **This PR** — tightened `spec-agent` SKILL (escalation gate before 👍); engine still relies on agent `Blocked` write (`facts.escalation` is not inferred from body text) |
| #2497 | Claude in rotation | **claude-a** eventually gets doorbells | Only **cursor-a** / **cursor-b** in the one-hour window | Retest after **#2510** with `on` + time or scripted history |
| #2498/#2499 | Rotation | Spec then review on separate issues | **Pass** under old LRU; re-validate under round robin | Soak resume |
| #2507 | Stalled → spec → review | Clear `Blocked`, spec, review, **`Ready`** | Spec + review **up** signed; **Stage stayed In analysis**; `busy` still set. **No `Refs #2507` PR** on the repo (user note “2707” → **#2507**) | **Operational:** cursor-b review finished **~17:04 UTC**, after **`dry-run` at 17:00:50** — convergence never applied. **Owner:** run a tick with `ISSUE_PIPELINE_V2=on` (still `pipeline-beta` scope) to advance to **Ready** and clear `busy`. If an agent opened a PR while still **In analysis**, that is off-pipeline delivery; close or retarget the PR and let the engine reach **Ready** first |
| #2508 | Shared login convergence | Two **distinct pool ids** must approve | **cursor-b** review in flight at soak end; same dry-run/timing risk as #2507 | Tick with `on` after review completes |
| #2493 | E2E | Toward **Done** | Stuck **In analysis** (time) | Continue soak |
| #2500/#2504 | no-convergence / launch-failed | Late branches | Never reached **In analysis** depth | Scripted votes / time |
| #2501/#2502 | WIP queue | **ready.queued** when WIP full | Preconditions not met (#2493 not **In progress**) | Drive #2493 delivery first |
| — | Matrix doc | Publish soak matrix on `main` | PR **#2509** blocked on branch policy | Merge when rules allow |
| — | `pre-push` on Cloud | Changed-files gate | **shellcheck** missing fails local script though tests pass | Install shellcheck in Cloud image or scope gate (debt) |

---

## Code and doc changes in this remediation PR

1. **`spec-agent` SKILL** — Before spec pass: check Delivery plan, DoD, soak `<!-- soak2:expect …` markers, and AGENTS.md §Escalation; set **`Blocked=decision`** instead of 👍 when owner must decide (covers #2495).
2. **`github-issue-workflow.md`** — Decision log **PIPE-V2-D-SOAK-007**: review convergence and `busy` clearing happen on the **next tick while `ISSUE_PIPELINE_V2=on`**; dry-run after the live window explains #2507/#2508 stage lag.
3. **This file** — Canonical soak2 record for owners and the next soak phase.

Round robin (**#2510**) is already on `main`; it is not repeated here.

---

## Recommended next soak steps

1. **`ISSUE_PIPELINE_V2=on`** for one tick (or short window) with label scope unchanged; unstick **#2507**, **#2508**, and any other **In analysis** + signed review fixtures.
2. Confirm **claude-a** appears in doorbells after **#2510**.
3. Merge **#2509** when branch protection allows.
4. Schedule long branches (#2504 launch-failed, #2500 no-convergence) separately.