---
title: Issue pipeline delivery PRs — babysit gap and proposed fix
owner: Documentation Team
audience: both
status: proposed
last_updated: 2026-11-26
tags: [agent-efficiency, github-issues, babysit, pipeline]
---

# Issue pipeline delivery PRs — babysit gap and proposed fix

> **Proposal (2026-11-26), draft for review.** This document changes no behaviour. The suggested changes in §Proposed changes are text for review and are not applied. Each one lands in its own PR after review.

## Problem

PR [#2651](https://github.com/AgathaTrack/AgathaTrack/pull/2651) (`feat(pet-care): offer sibling pets on carer app invite (AP-18)`) was opened at 11:12 UTC on 2026-11-26 by the pipeline agent `pawpet-claude`. The PR delivers issue [#2103](https://github.com/AgathaTrack/AgathaTrack/issues/2103) with `Refs #2103`.

Nothing drove the PR after it opened:

- Copilot review was requested at 11:13. No agent replied to threads, pushed a fix, or watched CI.
- Issue #2103 stayed `busy` with `Stage = In progress`.
- The PR stayed `blocked`.

Another agent picked up #2651 by hand and it merged to `main` as `a838ef5`. That fixes one PR and not the cause. Every agent-opened PR without another driver has the same problem.

> **Revision 2 (2026-11-26).** Applied review comments on PR #2658: decision-rule table moved into the policy (R4); R1 scope aligned to `prAuthors`; R7 added (light-plan end state for `Method: PR`); the claude-prepare line dropped (1d); the guard checks structured markers (1e); the Phase 2 design note made a prerequisite; open questions 2–4 tightened.

## Root causes

Each row cites the file that causes the gap. All seven were read on `main` at the time of writing.

| # | Where | What it does today |
|---|---|---|
| RC1 | `scripts/issue_pipeline_v2_launch.js`, `METHOD_PROMPTS` | `PR: ''`. The default delivery method (no `Method:` line means `PR`) adds no instruction beyond the base prompt. |
| RC2 | `scripts/pipeline_claude_prepare.js`, prompt assembly | The Claude run prompt says only "Follow AGENTS.md and CLAUDE.md". |
| RC3 | `docs/agent-efficiency/github-issue-workflow-behaviour.md` §Delivery contract | Four obligations: set `busy`, use `Refs`, tick the delivery DoD, clear `busy` or set `Blocked`. None covers review threads, CI or babysitting. |
| RC4 | `docs/agent-efficiency/autonomous-pr-policy.md` §Babysit skill family | The table lists `/light-plan`, `/execute-plan` and `/dependabot-batch`. It has no row for a pipeline PR. |
| RC5 | `.cursor/skills/babysit*/SKILL.md` and `.claude/skills/babysit*/SKILL.md` | `babysit`, `babysit-plus` and `babysit-uat` all set `disable-model-invocation: true`. A model cannot load them through the Skill tool, so a prompt that names them is not enough. Whether `claude-code-action` honours the flag in unattended runs is not verified. |
| RC6 | `.github/workflows/auto-babysit.yml` | Runs on `pull_request: [opened, synchronize, reopened]`. It calls `universal_babysit.sh --dry-run` with `continue-on-error`, and its permissions are read-only. It cannot push, reply to threads or resolve them. |
| RC7 | `scripts/issue_pipeline_v2*.js`, `scripts/issue_busy_watchdog.js` | The engine waits for the linked PR to merge. The busy watchdog only posts a comment on a `busy` issue after 6 hours of silence. Neither returns an agent to an open PR. |

## Requirements

- **R1.** Every PR a pipeline delivery opens has a babysit driver from the moment it opens until it merges or closes. Scope: any PR whose author is a pipeline login (`pawpet-claude`, `pawpet-bot`), or whose author is in the issue's `prAuthors` set (the logins that authored the issue's linked PRs, computed in `scripts/issue_pipeline_v2_decide.js`).
- **R2.** The driver follows the PR's base branch (decision rule in `autonomous-pr-policy.md`, see Phase 1a).
- **R3.** A delivery run does not end while the PR has an unresolved review thread or a Copilot review in progress. It either finishes the babysit loop or records a handoff with a `Blocked` reason on the issue.
- **R4.** The rule is written once, in `autonomous-pr-policy.md` §Babysit skill family, including the decision-rule table. The prompt and the delivery contract refer to that section and do not restate it. This plan doc keeps the history and is not a dependency of the policy.
- **R5.** `scripts/check_babysit_skill_family.js` fails CI if the policy section or its decision-rule table is removed (Phase 1e).
- **R6.** An open pipeline PR that no run is watching is picked up without a person doing it first (fallback, phase 3 below).
- **R7.** End state for default `Method: PR` matches light-plan: the delivery agent keeps `busy` through the merge and through Pre-UAT green on the merge SHA (for `main`), then ticks the delivery DoD and runs `finish-work`. It does not close the issue and does not write `Stage` while the engine owns it (`docs/agent-efficiency/github-issue-workflow-behaviour.md` §Delivery contract; `.cursor/skills/light-plan/SKILL.md` §Release).

## Decision rule (driver by base)

| PR base | Driver | Ends at |
|---|---|---|
| Integration branch (`cursor/*-integration-*`, or an execute-plan `base_branch`) | `/babysit-plus` | Squash merge into the integration branch |
| `main` | `/babysit-uat` | Pre-UAT E2E green on the merge SHA |
| Anything else | `/babysit-plus` | Squash merge; the run comments the unexpected base on the issue |

Plain `/babysit` is not a driver for agent PRs. It does not triage threads, apply fixes or gate the merge.

For a pipeline delivery with `Method: PR` the base is `main`, so the driver is `/babysit-uat`. Its remedial loop (`/e2e-debug`, at most 3 rounds) then applies to the delivery run.

## Proposed changes (not applied)

Phases are independent and each is one outcome, per `atomic-pr-policy.md`.

### Phase 1: policy, prompt and guard (docs and scripts only)

**1a. `docs/agent-efficiency/autonomous-pr-policy.md`, §Babysit skill family.** Add this family row to the table:

```markdown
| Issue-pipeline delivery PR (`Method: PR`, or any PR in the R1 scope) | Yes — driver per the decision rule below; delivery run keeps `busy` until the driver's gate passes (R3, R7) |
```

and add this subsection directly under the table, so the policy is self-contained:

```markdown
### Issue-pipeline delivery PRs

| PR base | Driver | Ends at |
|---|---|---|
| Integration branch (`cursor/*-integration-*`, or an execute-plan `base_branch`) | `/babysit-plus` | Squash merge into the integration branch |
| `main` | `/babysit-uat` | Pre-UAT E2E green on the merge SHA, then DoD ticks and `finish-work` (light-plan parity, R7) |
| Anything else | `/babysit-plus` | Squash merge; the run comments the unexpected base on the issue |

Plain `/babysit` is not a driver for agent PRs.
```

**1b. `docs/agent-efficiency/github-issue-workflow-behaviour.md`, §Delivery contract.** Replace obligation 4 with a fifth and sixth obligation:

```markdown
4. keep `busy` while the PR it opened is open and a babysit driver (autonomous-pr-policy §Babysit skill family, issue-pipeline subsection) is working it. For `Method: PR` the end state is Pre-UAT green on the merge SHA, then DoD ticks and `finish-work`, as light-plan does (R7).
5. remove `busy` when finished, or set `Blocked` with a reason when it gives up.
```

**1c. `scripts/issue_pipeline_v2_launch.js`, `METHOD_PROMPTS.PR`.** Replace the empty string with:

```js
PR:
  'Delivery method: PR. After you open the PR, do not finish yet. Pick the driver from the base branch (autonomous-pr-policy §Babysit skill family, issue-pipeline subsection): ' +
  '`/babysit-uat` (read `.cursor/skills/babysit-uat/SKILL.md`, or `.claude/skills/babysit-uat/SKILL.md` in Claude Code) when the base is `main`, ' +
  'otherwise `/babysit-plus` (read `.cursor/skills/babysit-plus/SKILL.md`, or `.claude/skills/babysit-plus/SKILL.md`). ' +
  'Read the skill file and follow it to completion. Do not invoke it through the Skill tool. After the driver ends, tick the DoD and run `finish-work` only when its gate has passed.',
```

**1d. Dropped.** The line proposed for `scripts/pipeline_claude_prepare.js` was a checkbox that could invite a checkbox reading of R3. 1c already carries the instruction, and `finish-work` is the gate. No change to `pipeline_claude_prepare.js` in Phase 1.

**1e. `scripts/lib/babysit_skill_family_policy.js` and `scripts/check_babysit_skill_family.js`.** The guard checks literal and regex markers, not table rows. Add to `POLICY_MARKERS`:

- the literal heading `### Issue-pipeline delivery PRs`,
- a regex that matches the `main` row naming `/babysit-uat`,
- a regex that matches the integration row naming `/babysit-plus`.

Add a test next to `check_babysit_skill_family.test.js` that removing any of the three fails the check (R5).

**Docs gate for Phase 1:** `## Docs` lists `docs/agent-efficiency/autonomous-pr-policy.md` and `github-issue-workflow-behaviour.md`, because they describe a behaviour change.

### Phase 2: event-driven trigger (needs owner approval and a design note first)

`.github/workflows/auto-babysit.yml` is a CI workflow change. `AGENTS.md` lists CI gate changes as requiring the owner's approval.

**Design note needed before this phase.** `pipeline-claude-run.yml` takes `stage` as a free-form string ("Canonical Stage name for this doorbell"). `babysit` is not a Stage name, and the prepare step only knows the doorbell and acceptance stages. Phase 2 therefore needs a design note that adds a non-Stage doorbell kind (for example `purpose: babysit`, alongside the existing `purpose: delivery` used by `buildLaunchRecord`), with its prompt from 1c and its launch record. The note goes into `github-issue-workflow-behaviour.md` §Launch before code.

- For PRs in the R1 scope, dispatch `pipeline-claude-run.yml` with the babysit purpose in place of the dry-run. The dispatch uses the base-branch rule.
- Other PRs keep the current dry-run.
- Skip fork PRs, since the pipeline token cannot act on them.

### Phase 3: engine fallback (needs owner approval, separate PR)

When a linked PR is open, has no active run and has an unresolved thread or a pending Copilot review for more than N hours, the engine rings the babysit doorbell (the same mechanism as the existing review and acceptance doorbells). This belongs in `github-issue-workflow-behaviour.md` §Transitions as a new row, and in the `issue_pipeline_v2_decide` code. N is a proposal for review. A starting point is 4 hours, which is less than the 24-hour stall rule.

## Acceptance criteria

1. A test pipeline PR gets a babysit run within one Phase 2 trigger cycle, verified by a dry run on a test branch.
2. A delivery run never ends with an unresolved thread and no `Blocked` reason.
3. Removing the pipeline row from the policy table fails `check_babysit_skill_family`.
4. Existing `light-plan`, `execute-plan` and `dependabot-batch` paths keep their current drivers. Verified by the existing tests.

## Open questions for review

1. **Driver on `main`.** Should `Method: PR` on `main` use `/babysit-uat`? The policy runs pre-UAT after every merge to `main`, so a babysit-uat driver fits, and light-plan already ends the same way (R7). Recommendation: yes. Cost: the run waits for the pre-UAT gate.
2. **`disable-model-invocation`.** Keep the flag, and have the prompt tell the agent to read the skill file (1c). Follow-up to verify: that `claude-code-action` reads files when instructed. Not verified in this proposal.
3. **Order of Phase 2 and Phase 3.** Recommendation: Phase 2 first, since it is event-driven and smaller. Phase 3 covers what Phase 2 misses. Phase 2 cannot start until its design note exists (see Phase 2).
4. **Handoff.** Timeouts hand off to the Phase 3 fallback. `Blocked` is for an unrecoverable agent failure only, consistent with the existing `stalled` and `launch-failed` holds.

## Non-goals

- No change to merge gates, `babysit_pr_reviews.js gate`, or the merge-lease scripts.
- No change to the babysit skills' frontmatter until question 2 is decided.
- No change to the acceptance (AAT) or prod gates.

## Rollout

1. This PR: the proposal only.
2. Phase 1 after review.
3. Phase 2 after the owner approves the CI change.
4. Phase 3 after Phase 2 has run on real pipeline PRs for a week and the remaining gap is known.
