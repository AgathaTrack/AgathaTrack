---
title: Soak testing policy
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [agent, pipeline, soak, testing]
related_prs: []
---

# Soak testing policy

Live **board soaks** (pipeline v2 ticks, `ISSUE_PIPELINE_V2=on`, often scoped with `pipeline-beta`) validate behaviour unit tests cannot fully model. They are **not** completion criteria on delivery issues.

**Executable specs:** [`docs/e2e/pipeline-soak-catalog.md`](../e2e/pipeline-soak-catalog.md) — registry, steps, pass criteria, regression reuse.

**Operators:** switch reference and historical soak notes in [github-issue-workflow-operations.md](./github-issue-workflow-operations.md).

## Decision log

| ID | Decision | Status |
|---|---|---|
| PIPE-V2-D-SOAK-010 | **Live board soaks are not Definition of Done items** on delivery issues. They are tracked in the soak catalog and batched in a **soak box** issue. `progress.finished` ignores catalog soaks | Accepted (owner, 2026-11-26) |

## Definition of Done (delivery issues)

Delivery **Definition of Done** covers **mergeable work only**: code on `main`, docs, tests in CI, PR hygiene, and acceptance criteria satisfied by automated verification where the issue states them.

Do **not** put these in delivery DoD:

- Live `pipeline-beta` (or other board) soaks
- “Run fixture #n To do → Done” checklists
- Owner manual board operations

At **review convergence**, spec and review agents **reject** a DoD that lists live soaks. Move soak intent to the catalog (new or existing `SOAK-REG-*` row) and defer execution.

### During **In progress**

1. If a soak spec already exists and the environment allows (`ISSUE_PIPELINE_V2`, label scope, fixtures free), the delivery agent **may** run it before `finish-work` — optional, not a gate.
2. If it **cannot** run (WIP full, no beta label, missing Projects PAT, owner soak window closed, fixture occupied), **defer**: add or update the catalog row, register the deferral on the current **soak box** issue, and complete delivery DoD without the soak.
3. On `finish-work`, only **delivery** DoD boxes must be `[x]`. Deferred soaks do not block **In Main**.

## Soak box issue (rolling batch)

One open **soak box** issue aggregates deferred soaks until the batch is drained.

| Item | Rule |
|------|------|
| **Title** | `[soak-box] Pipeline live soak batch <YYYY-MM>` (or next free month slug) |
| **Labels** | `task`, `soak-box`, `pipeline-beta` (fixtures receive engine writes) |
| **Stage** | Hand-driven or engine-owned per fixture; box itself may stay `manual-only` until runs start |
| **Body** | Summary, link to catalog, table of pending `SOAK-REG-*` rows (source issue, spec id, agent-runnable?, status) |
| **Definition of Done** | Every row in the batch table **Pass** or **Waived** with owner comment; catalog updated with outcomes |

When the batch is **done**: close the soak box issue, open a **new** soak box issue for the next batch (empty table). Do not reuse one issue forever — each box is one soak “sprint”.

### Suggested body template

```markdown
### Summary
Rolling batch of deferred live pipeline soaks. Specs live in `docs/e2e/pipeline-soak-catalog.md`.

### Batch registry
| SOAK-REG | Source | Agent | Label | Status |
|--------|--------|-------|-------|--------|
| SOAK-REG-001 | #2448 | yes | — | pending |

### Definition of Done
- [ ] Every row Pass or Waived (owner comment)
- [ ] Catalog updated with evidence links (agent run URLs, tick ids)
```

## Agent-runnable soaks

Every catalog entry must state whether an agent can run it **without human intervention**.

| Requirement | Detail |
|-------------|--------|
| **Steps** | Numbered, copy-paste commands; expected `Stage` / `Blocked` / marker outcomes |
| **Fixtures** | Issue numbers or how to create them; `Refs` rules; teardown |
| **Environment** | Repo variables (`ISSUE_PIPELINE_V2`, `ISSUE_PIPELINE_V2_LABEL`, `WIP_LIMIT`), secrets (names only) |
| **Pass** | Observable facts (org field values, comment markers, deploy run ids) — not “owner feels good” |
| **Evidence** | Agent posts run URL and tick summary lines on the soak box issue |

**Default:** soaks are **agent-runnable**. If a step needs a human org-field edit, prod approval, or subjective judgement, the fixture issue (or the catalog row) carries label **`soak-human`** and the spec’s **Agent-runnable** column is **no**, with the human step called out in bold.

Agents must not improvise soak steps not in the catalog when recording Pass.

## Waivers and risk acceptance

An owner may **waive** a catalog soak (risk acceptance comment on the soak box or source issue). The catalog row status becomes **Waived** with date and link. Waivers do not re-open delivery issues.

Delivery issues must not keep waived soaks in DoD (remove or never add).

## Regression

Re-run a catalog spec after engine changes touching `scripts/issue_pipeline_v2*.js`, acceptance gate, or deploy promotion. Note the run in the catalog **History** column or decision comment.

## Related labels

See [github-labels.md](./github-labels.md) § Pipeline soak.