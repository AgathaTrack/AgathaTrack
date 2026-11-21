---
title: Pipeline v2 soak2 live matrix
owner: Agent efficiency
audience: owner
status: active
last_updated: 2026-11-21
tags: [agent, pipeline, soak]
---

# Pipeline v2 soak2 — live test matrix

Canonical copy for owner review (replaces ephemeral agent artifacts). Issues **#2493–#2508**, label **`pipeline-beta`**, org **`Stage` = To do** (pre-set **`Blocked`** on #2496 `paused`, #2507 `stalled`). Supersedes **#2480–#2487** (closed).

Config checked against `.github/pipeline-agents.json`: WIP **2**, `runnerWip.claude` **1**, `aat.enabled` **true**, agents `cursor-a` / `cursor-b` (`pawpet-bot`) + `claude-a` (`pawpet-claude`).

## Dry-run tick (2026-11-21)

Manual `issue-pipeline-v2.yml` with `ISSUE_PIPELINE_V2=dry-run`: [Actions run 44925643941](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44925643941).

| Issue | `pipeline_v2_action` | Matches fixture? |
|-------|----------------------|------------------|
| #2493 | `request-spec` → `cursor-a` | yes |
| #2494 | `request-spec` → `cursor-a` | yes (DoR fails in agent) |
| #2495 | `request-spec` → `cursor-a` | yes (escalation later) |
| #2496 | `none` / `blocked.paused` | yes |
| #2497 | `request-spec` → `cursor-a` | yes (first pickup; not Claude yet) |
| #2498 | `request-spec` → `cursor-a` | yes |
| #2499 | `request-spec` → `cursor-a` | yes |
| #2500 | `request-spec` → `cursor-a` | yes |
| #2501 | `request-spec` → `cursor-a` | yes |
| #2502 | `request-spec` → `cursor-a` | yes |
| #2503 | `none` / `manual-only` | yes |
| #2504 | `request-spec` → `cursor-a` | yes |
| #2505 | `request-spec` → `cursor-a` | yes |
| #2506 | `request-spec` → `cursor-a` | yes |
| #2507 | `none` / `blocked` | yes (pre-set `stalled`; no wake while blocked) |
| #2508 | `request-spec` → `cursor-a` | yes |

After owner clears **`Blocked`** on #2507, the **next tick** should match other To do fixtures (`request-spec`, not `wake-stage-agent`). Human comments do not wake **`stalled`** the same way as `question`; clearing the field ends the blocked state.

## Fixture catalogue

| ID | Issue | Branch | Expected |
|----|-------|--------|----------|
| soak2-01 | #2493 | E2E happy path | To do → … → **In Main** → AAT pass → **In UAT** (green `deploy-uat.yml` contains merge) → **Done** only when green `deploy-prod.yml` contains merge + issue closed + `in-prod`. **Reopen-if-closed-early** (#2394): if a merged PR auto-closes the issue while still In progress / In Main / In UAT, engine reopens once (`v2:reopened`); not a separate fixture — observe only if it happens on this issue. |
| soak2-02 | #2494 | `question` | Spec agent cannot pass DoR; sets `Blocked=question`; human reply enables wake-once while still blocked. |
| soak2-03 | #2495 | `decision` | Escalation on sensitive wording → `Blocked=decision`. |
| soak2-04 | #2496 | `paused` | `blocked.paused`; comments do not wake until owner clears. |
| soak2-05 | #2497 | Claude doorbell | After per-issue rotation, `claude-a` doorbell; `pipeline_claude_verify` on silent runs. |
| soak2-06 | #2498 | Rotation | First spec on this issue: `cursor-a` (config order). |
| soak2-07 | #2499 | Rotation | Same tick as other To do issues: LRU **per issue** only (#2484). |
| soak2-08 | #2500 | `no-convergence` | In analysis: six votes without converge → `Blocked=no-convergence`. Long-running. |
| soak2-09 | #2501 | WIP queue | Docs-only typo; stays **Ready** / `ready.queued` while WIP full; **will open a real docs PR** when a slot frees. |
| soak2-10 | #2502 | WIP queue | Same as #2501 (docs-only). |
| soak2-11 | #2503 | `manual-only` | Engine never applies. |
| soak2-12 | #2504 | `launch-failed` | Ready → preflight refuses forbidden path; backoff **5 + 30 + 120** min + ack windows ≈ **2.5 h** to `Blocked=launch-failed`. |
| soak2-13 | #2505 | Feature DoR | Feature template spec. |
| soak2-14 | #2506 | Bug DoR | Bug template spec. |
| soak2-15 | #2507 | `stalled` clear → spec | While `Blocked=stalled`: `none` / `blocked`. **Owner clears `Blocked`** → next tick **`request-spec`** (normal To do), not blocked-comment wake. |
| soak2-16 | #2508 | Shared-login review | In analysis: need **two distinct pool ids** for `pawpet-bot` edits; signed verdicts require **`PIPELINE_RUN_SECRET`** on doorbell runs (derived from `PIPELINE_VOTE_KEY` + nonce in `issue_pipeline_v2_secrets.js`; passed in Cursor via `pipeline_runners/cursor.js`). |

## Timeout reassignment (explicit observation)

Not a dedicated fixture. On any **spec** or **review** pickup: after `reviewTimeoutMin` (30) without result, engine **edits the same** `v2:spec-request` / `v2:review-request` comment in place (`assigned=` / history updates) and reassigns to the next LRU agent. Watch comment id and `assigned=` across ticks.

## Explicitly deferred (not in soak2)

| Branch | Why deferred |
|--------|----------------|
| To do: all agents exhausted → `stalled` | **~90 min** (3 × 30 min). Optional overnight soak or owner sets `Blocked=stalled` + clear (#2507 covers clear → spec). |
| In analysis: all reviewers timeout → `stalled` | Same duration class; no separate issue — deferred with spec exhaustion. |
| AAT **fail** (`scope` / `implementation`) | Out of scope except happy pass on #2493. |
| Intent-review follow-ups | Out of scope while `aat.enabled` gates In Main (#2448). |
| `ready.backoff` without launch-failed | Covered implicitly by #2504 timing. |

## Production / deploy assumptions (#2493)

- Repo variable **`PROD_DEPLOY_ENABLED`** is **unset** (2026-11-21): prod path uses **stub** `vX.Y.Z-rc.N` tags per [github-issue-workflow.md §Production promotion](../github-issue-workflow.md); **not** full FTP prod deploy.
- Engine **Done** still requires a **successful** `deploy-prod.yml` run whose `head_sha` **contains** the issue’s latest merge into `main` (stub success still counts if the workflow is green).
- **Soak caveat:** with stub prod, **`in-prod` + Done** mean the workflow graph passed, **not** that customer production was updated. Accept for soak; do not treat `in-prod` as a real deploy signal here.
- Owner accepts: docs-only PR on **`main`** flows through **UAT pipeline** and **stub prod promotion** (`deploy-skipped-stub` when `PROD_DEPLOY_ENABLED` is unset).

## Go-live order (WIP 2, Claude cap 1)

Scope control: only issues carrying **`pipeline-beta`** receive writes when `ISSUE_PIPELINE_V2=on`. Remove the label from later phases until that phase starts.

1. **Phase A** (no WIP consumption; rotation on first tick): #2494, #2495, #2496, **#2498, #2499**, #2505, #2506, #2507 (clear `Blocked` first), #2508 — #2503 control (keep `pipeline-beta`; engine skips).
2. **Phase B**: add `pipeline-beta` to #2493 and #2497 (E2E + Claude doorbell).
3. **Phase C**: add `pipeline-beta` to #2501, #2502 **after** #2493 is **In progress** and they have reached **Ready** (spec + review first — expect delay before `ready.queued` is observable).
4. **Phase D** (long): add `pipeline-beta` to #2500 and #2504.

`ISSUE_PIPELINE_V2=on` with label scope from Phase A onward; read each tick’s `pipeline_v2_applied` lines before widening the label set.