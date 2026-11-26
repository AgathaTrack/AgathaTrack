---
title: Agent efficiency documentation index
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [agent-efficiency, documentation, index]
---

# Agent efficiency

Start here for **automation engines**, agent policies, and programme delivery on Agatha Track. Product behaviour lives under `docs/domains/`; CI and promotion live under `docs/pipelines/`.

## Which engine owns what

| Engine | Switch | Workflow / code | Canonical doc |
|--------|--------|-----------------|---------------|
| **Issue pipeline v2** | `ISSUE_PIPELINE_V2`, `ISSUE_PIPELINE_V2_LABEL`, `WIP_LIMIT` | [`issue-pipeline-v2.yml`](../../.github/workflows/issue-pipeline-v2.yml), `scripts/issue_pipeline_v2*.js` | [github-issue-workflow.md](./github-issue-workflow.md) (entry) — [behaviour](./github-issue-workflow-behaviour.md) · [wire](./github-issue-workflow-wire.md) · [operations](./github-issue-workflow-operations.md) |
| **Execute-plan v2 driver** | `EXECUTE_PLAN_DRIVER` | [`execute-plan-driver.yml`](../../.github/workflows/execute-plan-driver.yml), `scripts/execute_plan_runtime.js` | [execute-plan-runtime.md](./execute-plan-runtime.md) — spec in [plans/execute-plan-v2.md](./plans/execute-plan-v2.md) |
| **Legacy label flow** | (until v2 `on`) | `agent-dispatch`, `triage-human-reviewed`, `agent-monitor` | [github-issue-workflow.md § Legacy](./github-issue-workflow.md#live-workflow-legacy-until-issue_pipeline_v2on) |
| **Cursor dispatch (legacy)** | — | `launch-cursor-agent.js` | [github-issue-workflow.md § Cursor layer](./github-issue-workflow.md#cursor-agent-execution-layer) |
| **PR / docs babysit** | — | `scripts/universal_babysit.sh`, Copilot review | [autonomous-pr-policy.md](./autonomous-pr-policy.md), [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) |

Retired: assignee **v1 dispatcher** (`ISSUE_PIPELINE`, `issue-pipeline-dispatcher.yml`) — removed; history in [plans/issue-pipeline-automation.md](./plans/issue-pipeline-automation.md).

## Issue lifecycle (v2)

Org field **`Stage`**: Backlog → To do → In analysis → Ready → In progress → In Main → In UAT → Done. Transitions table, delivery contract, and Stage writes: [behaviour doc](./github-issue-workflow-behaviour.md). Comment markers and decision IDs: [wire doc](./github-issue-workflow-wire.md). Preview, soak, and switch reference: [operations doc](./github-issue-workflow-operations.md).

## Policies and runbooks

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](../../AGENTS.md) | Shared agent rulebook (toolchain, pre-push, GitHub issues) |
| [autonomous-pr-policy.md](./autonomous-pr-policy.md) | Merge gates, escalation, babysit family |
| [atomic-pr-policy.md](./atomic-pr-policy.md) | One outcome per PR |
| [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) | Review triage, CI cost |
| [github-labels.md](./github-labels.md) | Label taxonomy (`busy`, `manual-only`, AAT, …) |
| [governance-gates.md](./governance-gates.md) | Repo governance scripts |
| [scripts/README.md](../../scripts/README.md) | Babysit, validate_docs, pre-push entry points |

## Execute-plan (operating vs build spec)

| Doc | Audience | Contents |
|-----|----------|----------|
| [execute-plan-runtime.md](./execute-plan-runtime.md) | **Today** — operators and agents | CLI (`tick`, `watch-ci`, …), pre-push, bot tokens |
| [execute-plan-schema.md](./execute-plan-schema.md) | **Today** — snapshot authors | Schema v1 fields, control-issue labels |
| [plans/execute-plan-v2.md](./plans/execute-plan-v2.md) | Build / history | Full v2 programme, work packages |
| [plans/execute-plan-v2/contracts.md](./plans/execute-plan-v2/contracts.md) | Build / history | Snapshot schema v2, approve comments |
| [plans/execute-plan-v2/work-packages-*.md](./plans/) | Build / history | WP proofs and prompts — not day-to-day ops |

## Plans folder

Active and historical programmes: [plans/README.md](./plans/README.md).

## In-flight proposals

`changes/` holds pipeline proposals until accepted rows are folded into [wire § Decision log](./github-issue-workflow-wire.md#decision-log).