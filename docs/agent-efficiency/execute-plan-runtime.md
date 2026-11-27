---
title: Execute Plan Runtime
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-23
tags: [agent-efficiency, policy]
---
# Execute-plan runtime

Control issue + plan artifact runtime for `/execute-plan` v2 and `/babysit-plus`. Spec:
[execute-plan-v2.md](./plans/execute-plan-v2.md).

**Canonical policy:** [autonomous-pr-policy.md](./autonomous-pr-policy.md)  
**Snapshot schema (v1, authors):** [execute-plan-schema.md](./execute-plan-schema.md)  
**Snapshot schema (v2, driver):** [execute-plan-v2/contracts.md](./plans/execute-plan-v2/contracts.md) §3.1  
**Build spec / work packages (not day-to-day ops):** [plans/execute-plan-v2.md](./plans/execute-plan-v2.md)  
**Labels:** [github-labels.md](./github-labels.md)

Historical schema-1 snapshots under `.agents/plans/*.snapshot.json` are **records only** — not validated or loaded by active tooling except legacy roadmap CLI (see below).

---

## Library

Shared logic: `scripts/lib/execute_plan_lib.js` (drift classification, roadmap helpers). v2 snapshots:
`scripts/lib/execute_plan_snapshot_v2.js`.

```bash
node scripts/validate_execute_plan_snapshot.js .agents/plans/_example.v2.snapshot.json
node scripts/validate_execute_plan_snapshot.js --drift-test
```

---

## CLI — `scripts/execute_plan_runtime.js`

### v2 core

| Command | Purpose |
|---------|---------|
| `init <plan_id>` | Create control issue + v2 snapshot (init branch committed diff vs `main` must be only the two plan paths; uses `--no-renames`) |
| `tick <plan_id> [--json] [--actor agent\|driver]` | Observe → decide → persist (worker/driver) |
| `gate <plan_id>` | Alias of `tick` (no `--labels`) |
| `watch-ci <plan_id> --pr <n>` | Wait for required checks on a PR. Succeeds only when every required check is a completed `success` (see below). |
| `watch-preuat <plan_id>` | Wait for Pre-UAT on merged release |
| `watch-preuat-sha <merge_sha> [--json]` | Pre-UAT watch by merge SHA (also via `babysit_uat_watch_preuat.sh`) |
| `watch-deploy <plan_id>` | Wait for Deploy UAT proof job |
| `complete-plan <plan_id> [--write]` | v2 Definition of Done + close control issue |
| `check-diff --pr <n>` | Scope check helper for plan PRs |

Exit codes (`tick`): `0` action, `2` stop, `3` config/worker token.  
`init` also exits `3` when the init branch has committed paths other than `.agents/plans/<plan_id>.md`
(and the snapshot if already on the branch), or when the working tree is dirty outside those paths.

### Required check conclusions

`watch-ci` and the state machine (`prLadder` / `failureSignature`) share
`classifyRequiredCheck` in `scripts/lib/execute_plan_checks.js`. A required check has one decision:

| Conclusion | Decision |
|------------|----------|
| `success` and the check has completed | **success** — the only success |
| `failure`, `cancelled`, `timed_out`, `action_required`, `stale` | **failure** |
| `skipped` | **failure**. A required check that was skipped did not succeed. |
| `neutral` | **failure**. Neutral is not success for a check this programme requires. |
| empty conclusion, or not completed (`queued`, `in_progress`, `pending`, `missing`) | **pending** — `watch-ci` keeps polling; the state machine waits. Not a pass. |

Any other completed conclusion is a failure. `watch-ci` returns `conclusion: "success"` only when every required check is a success. A cancelled, skipped, or neutral required check is a failure (the watcher reports `failure`; the state machine takes the red-check path). Pending is not reported as success.

### Legacy roadmap (schema 1 on disk)

For closed programmes that still have `plan_kind: roadmap` snapshots:

```bash
node scripts/execute_plan_runtime.js roadmap-status <roadmap_id>
node scripts/execute_plan_runtime.js roadmap-next-child <roadmap_id>
node scripts/execute_plan_runtime.js roadmap-set-child <roadmap_id> --child <id> --status <status> [--write]
```

New programmes use v2 `init` only.

---

## Pre-push

Validates `.agents/plans/_example.v2.snapshot.json` only (v1 example removed in WP10).

---

## Related

[execute-plan-schema.md](./execute-plan-schema.md) (v1 snapshot fields) · [execute-plan-instruction-stack.md](./execute-plan-instruction-stack.md) · [execute-plan skill](../../.cursor/skills/execute-plan/SKILL.md) · [agent-efficiency README](./README.md)
