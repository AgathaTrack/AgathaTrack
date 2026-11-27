---
title: GitHub issue workflow (pipeline v2)
domain: cross-domain
feature_id: github-issue-workflow
status: active
last_updated: 2026-11-26
related_prs: [2665]
tags: [agent, pipeline, github]
---

# GitHub issue workflow (pipeline v2)

Product behaviour and wire decisions for the v2 issue pipeline live in the agent-efficiency split:

| Doc | Holds |
|-----|--------|
| [github-issue-workflow-behaviour.md](../../../agent-efficiency/github-issue-workflow-behaviour.md) | Stages, labels (v2), engine-visible acceptance |
| [github-issue-workflow-wire.md](../../../agent-efficiency/github-issue-workflow-wire.md) | Decision log, field wiring |

Proposals and in-flight delivery: `docs/agent-efficiency/changes/`. This file is the domain feature anchor for change-doc `folds_into` gates only until a fuller consolidate migrates requirements here.

## Requirements

| ID | Rule | Status |
|----|------|--------|
| GITHUB-ISSUE-WORKFLOW-R-001 | Pipeline v2 stage machine, acceptance, and promotion behaviour is specified in the agent-efficiency behaviour and wire docs linked above | Live |

## Decision log

| ID | Decision | Rationale | Status | Date | PR |
|----|----------|-----------|--------|------|-----|
| GITHUB-ISSUE-WORKFLOW-D-001 | Canonical product spec for this capability remains in `docs/agent-efficiency/github-issue-workflow-behaviour.md` and `github-issue-workflow-wire.md` until `/canonical-docs consolidate` | Split wire vs behaviour predates domain feature docs | Live | 2026-11-26 | 2665 |

## Acceptance criteria

Given the behaviour doc is the operational spec, when a change proposal under `docs/agent-efficiency/changes/` lists this file as `folds_into`, then validation gate R-B2 accepts the target (GITHUB-ISSUE-WORKFLOW-R-001).