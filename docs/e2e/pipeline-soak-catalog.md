---
title: Pipeline live soak catalog
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [e2e, pipeline, soak, regression]
related_prs: [2655]
---

# Pipeline live soak catalog

Authoritative **steps and pass criteria** for live pipeline v2 board soaks. Policy (DoD exclusion, soak box, deferral): [soak-testing.md](../agent-efficiency/soak-testing.md).

**Column legend**

| Column | Meaning |
|--------|---------|
| **Agent** | `yes` — agent runs without human steps; `no` — needs `soak-human` on fixture and operator preamble |
| **Batch** | Soak box issue tracking the deferred run (when known) |

---

## SOAK-REG-001 — In Main AAT gate (dual path + fail reasons)

| Field | Value |
|-------|-------|
| **Source** | [#2448](https://github.com/AgathaTrack/AgathaTrack/issues/2448) (gate on `main` via #2479) |
| **Agent** | **no** (operator must arm live ticks; see §Operator) |
| **Batch** | TBD — open next `soak-box` issue |
| **Status** | **Waived** 2026-11-26 — [owner risk acceptance on #2448](https://github.com/AgathaTrack/AgathaTrack/issues/2448#issuecomment-7191295003); owner confirmed deferral on PR #2655. Unit tests on `main` are the regression oracle until a future soak box run |

### Operator (human) — once per soak window

1. In GitHub **Settings → Secrets and variables → Actions**, set repository variables (names only; values per [operations doc](../agent-efficiency/github-issue-workflow-operations.md)):
   - `ISSUE_PIPELINE_V2=on`
   - `ISSUE_PIPELINE_V2_LABEL=pipeline-beta`
   - Optional: `WIP_LIMIT=off` for drain-only windows; remove when done.
2. Confirm org fields **Acceptance** and **Acceptance fail reason** exist on the Pawpet project.
3. Record variable state and window start time on the soak box issue.

Delivery agents **must not** perform step 1; escalation applies.

### Preconditions (fixtures)

- `aat.enabled: true` in `.github/pipeline-agents.json` on `main`
- One **fixture issue per scenario** (fresh titles; label `pipeline-beta` + `soak-human` until operator step above is done)
- Fixture body: `Method: PR`, minimal acceptance criteria, delivery DoD without live soak rows

### Scenario A — Pass + UAT

1. Open fixture issue `#F`; delivery merges a trivial `Refs #F` PR to `main`; note `mergeSha`.
2. Tick delivery DoD; `finish-work`; wait until `Stage` is **In Main** (engine may `launch-aat`).
3. As listed agent, run acceptance (skill) or post pass marker:
   ```bash
   node scripts/github_issue_workflow.js aat-pass --issue <F> --merge <mergeSha> --body-file <verdict.md>
   ```
4. Wait for green `deploy-uat.yml` whose commit contains `mergeSha` (see `uatContainsLatestMerge` in tests).
5. **Pass:** org field `Stage=In UAT`; evidence: deploy run URL + issue timeline on soak box issue.

### Scenario B — `quality` fail

1. Reach **In Main** as in A.1–A.2.
2. Post fail marker:
   ```bash
   node scripts/github_issue_workflow.js aat-fail --issue <F> --merge <mergeSha> --reason quality --body-file <verdict.md>
   ```
3. **Pass:** `Stage` stays **In Main**; `Acceptance fail reason=quality`; no move to In UAT until a newer `Refs #F` merge lands on `main`.

### Scenario C — `scope` fail

1. Reach **In Main**; post `aat-fail --reason scope` as in B.2.
2. **Pass:** `Stage=In progress`; on ticks with same `lastMergeSha`, `progress.finished` does **not** return to In Main (see `issue_pipeline_v2_acceptance.test.js` “each fail reason”).
3. After engine `aat-relaunch` once, expect delivery continuation comment with `v2:aat-relaunch`.

### Scenario D — `implementation` fail

1. File follow-up **#B** whose body starts with `<!-- v2:follow-up of=#F -->`; open fix PR with `Refs #F` and `Refs #B`.
2. On parent **#F** at In Main, post `aat-fail --reason implementation`.
3. **Pass:** parent rewinds to **In progress**; while follow-up **#B** is open (`aat.implementation-waiting`), the engine does not set `Blocked=stalled` (`aat.implementation-quiet` applies only when no follow-up and no linked PR remain); a parent-linked merge to `main` ends suppression.

### Regression trigger

Changes to `scripts/issue_pipeline_v2_acceptance.js`, `issue_pipeline_v2_decide.js`, `issue_pipeline_v2_apply.js`, `issue_pipeline_v2_release.js` (`dodComplete`), `.github/pipeline-agents.json` `aat`, or deploy-uat promotion.

---

## SOAK-REG-002 — (placeholder)

Reserve for next deferred soak. Add rows here; do not add live soaks to delivery issue DoD.