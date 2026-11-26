---
title: Soak testing policy
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [agent, pipeline, soak, testing]
related_prs: [2655]
---

# Soak testing policy

Live **board soaks** (pipeline v2 ticks, `ISSUE_PIPELINE_V2=on`, often scoped with `pipeline-beta`) validate behaviour unit tests cannot fully model. They are **not** completion criteria on **delivery** issues.

**Executable specs:** [`docs/e2e/pipeline-soak-catalog.md`](../e2e/pipeline-soak-catalog.md) — registry, steps, pass criteria, regression reuse.

**Operators:** switch reference and historical soak notes in [github-issue-workflow-operations.md](./github-issue-workflow-operations.md).

## Decision log

| ID | Decision | Status |
|---|---|---|
| PIPE-V2-D-SOAK-010 | **Live board soaks are not Definition of Done items** on delivery issues. They live in the soak catalog and batch in a **soak box** issue. The engine skips unticked rows only when the line **starts** with **`<!-- soak-dod:defer -->`** (see §Deferral markers). `SOAK-REG-*` in the catalog is not an engine gate bypass. Spec/review agents reject new live-soak DoD rows at convergence | **Accepted** (owner, 2026-11-26): owner directed merge via **PR #2655** (`/babysit-plus`); [#2448#issuecomment-7191295003](https://github.com/AgathaTrack/AgathaTrack/issues/2448#issuecomment-7191295003) (board soak waived) |

This policy does **not** grant agents permission to change repo **Actions variables** (`ISSUE_PIPELINE_V2`, `ISSUE_PIPELINE_V2_LABEL`, `WIP_LIMIT`). Only owners/operators set those (AGENTS.md §Escalation — CI / pipeline gate).

## Definition of Done (delivery issues)

Delivery **Definition of Done** covers **mergeable work only**: code on `main`, docs, tests in CI, PR hygiene, and acceptance criteria satisfied by automated verification where the issue states them.

Do **not** put these in delivery DoD:

- Live `pipeline-beta` (or other board) soaks
- “Run fixture #n To do → Done” checklists
- Owner manual board operations

At **review convergence**, spec and review agents **reject** a DoD that lists live soaks. Move soak intent to the catalog (new or existing `SOAK-REG-*` row) and defer execution.

### Deferral markers (engine)

If a legacy DoD row must stay on a delivery issue while a soak is deferred, keep it **unchecked** and **start the line** with the engine marker only (a `SOAK-REG-*` id in the text does not defer):

```markdown
- [ ] <!-- soak-dod:defer --> SOAK-REG-001 live board soak (see catalog)
```

Prefer removing live-soak rows from delivery DoD entirely and tracking them only in the catalog and soak box. Otherwise `progress.finished` stays blocked on that `- [ ]` row.

### During **In progress**

1. If a soak spec already exists and the environment is already in a soak window (variables set by an **operator**; fixtures free), the delivery agent **may** run catalog steps before `finish-work` — optional, not a gate.
2. If it **cannot** run, **defer**: add or update the catalog row, register the deferral on the current **soak box** issue, and complete delivery DoD without the soak.
3. On `finish-work`, only **delivery** DoD boxes must be `[x]` (plus allowed deferred soak rows as above). Deferred soaks do not block **In Main**.

## Soak box issue (rolling batch)

One open **soak box** issue aggregates deferred soaks until the batch is drained.

| Item | Rule |
|------|------|
| **Title** | `[soak-box] Pipeline live soak batch <YYYY-MM>` (or next free month slug) |
| **Labels** | `task`, `soak-box` on the **tracker**; `pipeline-beta` only on **fixture** issues the engine writes to |
| **Stage** | Tracker is usually `manual-only` or owner-driven; fixtures follow normal pipeline stages |
| **Body** | Summary, link to catalog, table of pending `SOAK-REG-*` rows (source issue, spec id, agent-runnable?, status) |

**Soak box DoD** (Pass/Waived per row) applies **only to soak box issues**, not delivery issues — it is how the batch closes.

When the batch is **done**: close the soak box issue, open a **new** soak box issue for the next batch (empty table).

### Suggested body template

```markdown
### Summary
Rolling batch of deferred live pipeline soaks. Specs live in `docs/e2e/pipeline-soak-catalog.md`.

### Batch registry
| SOAK-REG | Source | Agent | Label | Status |
|--------|--------|-------|-------|--------|
| SOAK-REG-001 | #2448 | no | soak-human | pending |

### Definition of Done (soak box only)
- [ ] Every row Pass or Waived (owner comment)
- [ ] Catalog updated with evidence links (agent run URLs, tick ids)
```

## Agent-runnable soaks

Every catalog entry must state whether an agent can run it **without human intervention**.

| Requirement | Detail |
|-------------|--------|
| **Steps** | Numbered, copy-paste commands; expected `Stage` / `Blocked` / marker outcomes |
| **Fixtures** | Issue numbers or how to create them; `Refs` rules; teardown |
| **Environment** | Repo variables (names only); must already be set by an operator |
| **Pass** | Observable facts (org field values, comment markers, deploy run ids) |
| **Evidence** | Agent posts run URL and tick summary lines on the soak box issue |

**Default:** soaks are **agent-runnable**. If a step needs a human org-field edit, repo variable change, prod approval, or subjective judgement, the catalog **Agent** column is **no**, fixtures carry **`soak-human`**, and human steps are listed under **Operator (human)**.

Agents must not improvise soak steps not in the catalog when recording Pass.

## Waivers and risk acceptance

An owner may **waive** a catalog soak (risk acceptance comment on the soak box or source issue). The catalog row status becomes **Waived** with date and link. Waivers do not re-open delivery issues.

Prefer removing live-soak bullets from delivery DoD entirely; do not leave waived soaks as unticked rows unless they carry a deferral marker.

## Regression

Re-run a catalog spec after engine changes touching `scripts/issue_pipeline_v2*.js`, acceptance gate, or deploy promotion. Note the run in the catalog **History** column or decision comment.

## Related labels

See [github-labels.md](./github-labels.md) § Pipeline soak.