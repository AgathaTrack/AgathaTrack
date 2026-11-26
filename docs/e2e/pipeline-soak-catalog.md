---
title: Pipeline live soak catalog
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [e2e, pipeline, soak, regression]
---

# Pipeline live soak catalog

Authoritative **steps and pass criteria** for live pipeline v2 board soaks. Policy (DoD exclusion, soak box, deferral): [soak-testing.md](../agent-efficiency/soak-testing.md).

**Column legend**

| Column | Meaning |
|--------|---------|
| **Agent** | `yes` — agent runs without human steps; `no` — needs `soak-human` on fixture |
| **Batch** | Soak box issue tracking the deferred run (when known) |

---

## SOAK-REG-001 — In Main AAT gate (dual path + fail reasons)

| Field | Value |
|-------|-------|
| **Source** | [#2448](https://github.com/AgathaTrack/AgathaTrack/issues/2448) (gate on `main` via #2479) |
| **Agent** | yes |
| **Batch** | TBD — open next `soak-box` issue |
| **Status** | pending (deferred from delivery; unit tests green on `main`) |

### Preconditions

- `aat.enabled: true` in `.github/pipeline-agents.json`
- Org fields `Acceptance` and `Acceptance fail reason` present
- `ISSUE_PIPELINE_V2=on`, `ISSUE_PIPELINE_V2_LABEL=pipeline-beta` on fixtures only
- Dedicated fixture issues (create fresh; do not reuse production delivery issues)

### Scenarios (separate fixtures recommended)

Each scenario is one fixture issue with `pipeline-beta`, minimal body, `Method: PR`, and delivery that merges a trivial doc commit to `main` so `lastMergeSha` exists.

1. **Pass + UAT** — Agent acceptance pass marker for merge sha + successful `deploy-uat` containing that sha → `Stage` **In UAT**.
2. **`quality` fail** — Actionable `aat-fail` `reason=quality` → stays **In Main** until a newer linked merge to `main`.
3. **`scope` fail** — `reason=scope` → **In progress**, does not return **In Main** until newer merge; one scope relaunch per spec.
4. **`implementation` fail** — Follow-up issue with `<!-- v2:follow-up of=#parent -->`, parent `Refs` on fix PR → parent suppressed until merge; **no** `Blocked` while follow-up or linked PR open.

### Pass criteria

| Scenario | Pass when |
|----------|-----------|
| 1 | `Stage=In UAT`, `Acceptance=Passed` (or actionable pass), deploy run id cited |
| 2 | `Stage=In Main`, `Acceptance fail reason=quality` |
| 3 | `Stage=In progress`, no premature **In Main** on same `lastMergeSha` |
| 4 | `Stage` and `Blocked` match §implementation rows in [github-issue-workflow-behaviour.md](../agent-efficiency/github-issue-workflow-behaviour.md) |

### Agent procedure (summary)

1. Read full scenario steps in engine spec tables (issue #2448 body / `issue_pipeline_v2_acceptance.test.js` names as oracle).
2. For each scenario: create fixture → drive delivery to **In Main** → post verdict markers via `github_issue_workflow.js` aat-* **as listed agent** or trigger engine `launch-aat` and wait for ticks (record workflow run url).
3. Post evidence on soak box issue; set catalog **Status** to `pass` with date.

### Regression trigger

Changes to `scripts/issue_pipeline_v2_acceptance.js`, `issue_pipeline_v2_decide.js`, `issue_pipeline_v2_apply.js`, `.github/pipeline-agents.json` `aat`, or deploy-uat promotion rules.

---

## SOAK-REG-002 — (placeholder)

Reserve for next deferred soak. Add rows here; do not add live soaks to delivery issue DoD.