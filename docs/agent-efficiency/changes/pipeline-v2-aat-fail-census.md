---
title: Pipeline v2 AAT fail-marker census (placeholder)
owner: Agent efficiency
audience: owner
status: proposed
last_updated: 2026-11-27
tags: [agent, pipeline, acceptance, aat]
---

# AAT fail-marker census (P3 gate)

Hard gate for enabling `aat.autoSkip.enabled` in production config: this census records how often acceptance failed before merge, split roughly by changed-path class.

## Method

1. Search the repository default branch issue comments for `<!-- v2:aat` markers with `verdict=fail` and a known `reason=` (`scope`, `implementation`, or `quality`).
2. Search closed issues whose org field history (from `v2:aat-state` markers after P4, or thread inspection before that) shows `Acceptance=Failed`.
3. For each issue, bucket linked merged PR changed paths into:
   - **low-risk** (would match default `aat.autoSkip.globs`),
   - **app/API** (`server/**`, `flutter_app/**`, `db/**`, `infra/**`),
   - **workflow** (`.github/**`, `.cursor/agent-kernel/**`, `scripts/issue_pipeline_v2*`),
   - **mixed** (more than one bucket).
4. Approximate counts from a repo-wide code search of issue templates and docs referencing fail markers (full Projects field export is not available to agents).

## Date

2026-11-27 (P3 implementation PR).

## Result (approximate)

| Signal | Approximate count | Notes |
|--------|-------------------|-------|
| `v2:aat verdict=fail` in tracked docs/templates | 0 in-repo | Markers live on GitHub issues, not in git |
| Issues labelled `AAT-failed` (historical) | 2 | #2342, #2363 per acceptance-simplification F6 |
| `Acceptance=Failed` transitions | not enumerated | Requires issue export; treat as **incomplete** until owner attaches a fresh export |

**Recommendation:** Keep `aat.autoSkip.enabled` **false** until the owner attaches a dated export with per-issue path buckets. This placeholder satisfies the P3 PR attachment requirement for method and date; counts remain approximate.