---
name: light-plan
description: Single-agent sequential plan — phase PRs merge-committed one by one into an integration branch, one release PR to main after a full self-review, then /babysit-uat through Pre-UAT green (issue stays open; Actions track In Main → In UAT → Done). Stays in session while CI or Pre-UAT is still running. Use for 2–4 phases. /execute-plan when you need scope/budget guarantees or a longer programme.
disable-model-invocation: true
---

# Light-plan

Minimal sequential programme — tracking issue only; no execute-plan runtime. Policy links: [`merge-policy.mdc`](../../rules/merge-policy.mdc) · [`pr-hygiene.mdc`](../../rules/pr-hygiene.mdc) · integration ruleset [runbooks §7.2](../../../docs/agent-efficiency/plans/execute-plan-v2/runbooks-proof-retirement.md).

## Run to completion

- `/light-plan` delivers a release squash-merged to `main` and Pre-UAT green on that SHA. The release PR uses `Refs #<issue>` (not `Closes`). Remove `busy` after Pre-UAT green; **do not** close the tracking issue — the pipeline moves it **In Main** → **In UAT** → **Done** (delivery contract: [`github-issue-workflow.md`](../../../docs/agent-efficiency/github-issue-workflow.md) §Delivery contract).
- Do not end the turn or ask the owner at a step boundary (setup done, phase merged, checklist tick, sync PR, waiting on CI — `gh pr checks --watch`; waiting on review — `node scripts/babysit_pr_reviews.js wait --pr <url>`).
- End the turn only for stops in §Stop and ask, blocked `./scripts/pre-push.sh` in §Final self-review, or Done (§Release). Leaving merge, Pre-UAT, or issue close for a later session is not an ending.
- Put status on the tracking issue (checklist ticks with PR links). Never ask for acknowledgement.

## When to use

| Workflow | When |
|----------|------|
| **`/light-plan`** | 2–4 sequential phases, ≤ ~2 days, no owner check-ins between phases |
| **`/execute-plan`** | Many phases; snapshot, budgets, driver, and automatic relaunch when you need scope/budget guarantees |
| **`/spawn-sprint-agents`** | Parallel agents on disjoint paths |

## Plan (tracking issue)

One GitHub issue with a one-sentence goal and `- [ ] P<n> — <outcome> — scope: <paths>`. The issue is the programme's only state (no runtime). Run `node scripts/github_issue_workflow.js start-work --issue <n> --body "…"`. No `plan:` labels. **Do not** open the release PR early (draft CI re-runs on every integration merge). Then start P1 immediately.

## Branches

- Integration: `cursor/<slug>-integration-<4 lowercase alnum>` from `main` (CI + ruleset `cursor/*-integration-*`).
- Dev (reused): `cursor/<slug>-dev` from integration; optional agent suffix on dev only.

## Phase loop (sequential)

**Leave integration where it is.** Do not open a `main` → integration PR because the branch is behind `main`. Merge integration into local dev, then implement the phase. A `main` → integration PR exists only to resolve a conflict on the release (§Release): merge commit, never rebase (`non_fast_forward`). An unclear conflict → stop and ask.

Implement the current phase per its checklist scope (files needed for that outcome → add them to that phase's scope on the checklist, note why on the issue, continue; stop only if the goal itself would change). Pre-PR self-review ([`pr-hygiene.mdc`](../../rules/pr-hygiene.mdc)) + `./scripts/pre-push-changed.sh`; open PR dev → integration (ready for review, not draft).

**Phase and sync PRs run through [`/babysit-plus`](../babysit-plus/SKILL.md)** — with the `light-plan` label on, every PR this skill opens (phase dev → integration, sync, self-review fix) is driven by babysit+ (§0b Copilot/reviews wait, §2 triage, §3–4 fixes and debt issues, §5 CI loop, §7 review gate and merge). Even if the integration ruleset is inactive, babysit+ still requires green CI and **every review conversation resolved** (autonomous-pr-policy §Babysit skill family). Only the release PR leaves babysit+ for `/babysit-uat` (§Release).

1. Run `/babysit-plus` on the PR until §7 merges it. The review gate `node scripts/babysit_pr_reviews.js gate --pr <url>` must exit `0` before the merge; `2` → triage and reply+resolve, re-run; `1` → fix the script, never merge on error.
2. Merge phase and sync PRs with babysit+'s squash merge (§7). The one exception is the `main` → integration sync PR that resolves a release conflict: merge it with a **merge commit**, never squash or rebase, so integration keeps `main` as a parent and the release PR stays mergeable.

Babysit+ on a phase PR is a full babysit+ run (pre-PR self-review, triage comment, `pre-push-changed.sh`); an execute-plan merge lease is not needed here. Deferred review → debt issue, linked from the tracking issue.

Remote dev deleted on merge: `git fetch origin <integration>`, merge into local dev, `git push -u origin cursor/<slug>-dev`. Tick checklist with PR link. Then start the next phase, or §Final self-review after the last one, in the same turn.

Self-review fixes use the same dev → integration light merge.

## Final self-review (before release PR)

**Release diff:** review `origin/main...<integration>`. Do not merge `main` into integration before that review.

- Goal + checklist done; cross-phase seams (dead code, dup helpers, half renames, TODOs)
- Files outside any phase scope (justify or revert)
- `/canonical-docs sync`; `## Docs` ready; combined test coverage; sensitive paths (`.github/scripts/agent-safety-lib.js`)
- Tracking deferrals: fix now or note in release PR body
- `./scripts/pre-push.sh` green — if blocked, stop and record on tracking issue (release also runs full suite via `/babysit-uat`)

Record under `## Self-review` on the release PR.

## Release

Open integration → `main` only now. Body: goal, phase links, `## Self-review`, `## Docs`, `Refs #<issue>` (**not** `Closes`). Read and follow [`/babysit-uat`](../babysit-uat/SKILL.md) in the same turn (builds on [`/babysit-plus`](../babysit-plus/SKILL.md); remedial via [`/e2e-debug`](../e2e-debug/SKILL.md) when needed). On this release, do not run `babysit_sync_base.sh --push`: a `MERGEABLE` head squash-merges while `BEHIND`. Programme-owned merges: [`AGENTS.md`](../../../AGENTS.md) §Autonomy and merging.

Re-read this section before opening that PR, and again before any user-facing message while the programme is unfinished. Until Done, take the first matching action. Do not describe it and stop.

| Situation | Action |
|-----------|--------|
| Required checks pending or running (Playwright, `ci-gate`, any other required check) | `gh pr checks <url> --watch` until every required check has finished. A fixed `sleep` or a one-shot `gh pr checks` does not finish the wait. |
| A check failed | Fix inside `/babysit-uat`. Retry budget exhausted → §Stop and ask. |
| `mergeable` is `MERGEABLE`, including `mergeStateStatus` `BEHIND`; checks green; review gate exit `0` | Squash-merge. Do not update integration from `main`. If GitHub rejects the merge because the head is out of date, stop: ruleset 18979034 still has strict status checks. Do not open a sync PR. |
| `mergeable` is `CONFLICTING`, or preflight exit `4` | One PR that merges `main` into integration and resolves the conflict. Light-merge it, then watch the release again. |
| Release head moved because that conflict PR merged | Watch CI on the new head. |
| Merged, Pre-UAT not yet green | `./scripts/babysit_uat_watch_preuat.sh <merge_sha> --json --timeout-min 90`. Failure → Phase 3–4, then watch again. |
| Pre-UAT green | Tick the checklist, comment the merge SHA and pre-UAT run URL, remove `busy` (`node scripts/github_issue_workflow.js` or `gh issue edit` labels). **Do not** `gh issue close` — the pipeline advances **In Main** / **In UAT** / **Done** (and reopens an issue a merge auto-closed). |

Done when that last row has happened. A later message that only says `/babysit-plus` or "merge it" still owes the Pre-UAT watch and the `busy` removal. If this conversation is woken by a CI subscription, the first action is the matching row — the wake is not an owner question.

Pre-UAT green ends the **agent session**; UAT deploy and prod notify close the issue via Actions. Do not wait for Deploy UAT notify in-session unless you are babysitting a product issue outside a programme.

Do not end the turn while the release PR is open or Pre-UAT is unfinished, except [§Stop and ask](#stop-and-ask). Never ask the owner to merge, to run `/babysit-uat`, or to pick the work up in another session.

## Recovery

If the run is cut off (platform limit, crash, or the owner stops it), resume with `continue light-plan #<issue>`. Read the checklist and branch heads first. The agent never ends a turn just to use this. When pipeline v2 launched the run (a `v2:launch` comment on the issue), the engine may issue one `resume` action on a later tick, then `Blocked: stalled` if delivery still does not progress (`github-issue-workflow.md` §Pipeline v2, In progress row). Outside v2, `agent-monitor.yml` still handles terminal Cursor runs while `ISSUE_PIPELINE_V2` is not `on`.

## Stop and ask

[`AGENTS.md`](../../../AGENTS.md) §When to ask, plus: CI retry budget exhausted per `autonomous-pr-policy.md` §CI retry budget; a change to the goal; unresolvable main/integration conflict. One question + recommendation on the tracking issue; start the final message with `Need owner decision:` so the monitor does not relaunch the run (`busy` stays set). Pending CI, an open release PR, Pre-UAT still running, and an open tracking issue are not stops.

## Not included

No snapshot, runtime, driver, approval or budgets. Every phase and sync PR runs `/babysit-plus`; the release PR runs `/babysit-uat`, which builds on it. Full [`autonomous-pr-policy.md`](../../../docs/agent-efficiency/autonomous-pr-policy.md) applies to both. Need guarantees → `/execute-plan`.
