---
title: Issue pipeline delivery PRs — babysit gap and proposed fix
owner: Documentation Team
audience: both
status: in-delivery
status_note: Phases 1 and 4 shipped 2026-11-26 (#2664, #2670). Event-driven auto-babysit live dispatch and Copilot-aware fallback remain open (see Phase 2–3 below).
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

- **R1.** Every PR a pipeline delivery opens has a babysit driver from the moment it opens until it merges or closes. Scope: any PR whose author is a pipeline login (`pawpet-claude`, `pawpet-bot`), or whose author is in the issue's `prAuthors` set. `prAuthors` is produced in `scripts/issue_pipeline_v2_release.js` (about line 185) from the issue's **merged** linked PRs only, so an open PR by a new author is not covered by this set. `scripts/issue_pipeline_v2_decide.js` only consumes it. Phase 1 covers the pipeline logins and the set as it stands. Widening the set to open PRs would change the engine and is a separate decision.
- **R2.** The driver follows the PR's base branch (decision rule in `autonomous-pr-policy.md`, see Phase 1a).
- **R3.** A delivery run does not end while the PR has an unresolved review thread or a Copilot review in progress. It either finishes the babysit loop or records a handoff with a `Blocked` reason on the issue.
- **R4.** The rule is written once, in `autonomous-pr-policy.md` §Babysit skill family, including the decision-rule table. The prompt and the delivery contract refer to that section and do not restate it. This plan doc keeps the history and is not a dependency of the policy.
- **R5.** `scripts/check_babysit_skill_family.js` fails CI if the policy section or its decision-rule table is removed (Phase 1e).
- **R6.** An open pipeline PR that no run is watching is picked up without a person doing it first (fallback, phase 3 below).
- **R7.** End state for default `Method: PR`: the delivery agent keeps `busy` through squash merge (driver `/babysit-plus` per [autonomous-pr-policy.md](../autonomous-pr-policy.md) §Driver routing row 11), then ticks the delivery DoD and runs `finish-work`. Pre-UAT runs asynchronously in Actions. It does not close the issue and does not write `Stage` while the engine owns it. Supersedes the pre-UAT-green end state from revision 2 ([babysit-routing-reconciliation.md](../changes/babysit-routing-reconciliation.md) §8 C2).

## Decision rule (driver by base)

**Canonical table:** [autonomous-pr-policy.md](../autonomous-pr-policy.md) §Driver routing rows 10–11. This doc does not duplicate it.

For `Method: PR` with base `main`, the driver is `/babysit-plus`; pre-UAT is async. A red `main` is handled outside the delivery session (policy §Post-merge pre-UAT; routing spec §8 C1).

## Proposed changes (not applied)

Phases are independent and each is one outcome, per `atomic-pr-policy.md`.

### Phase 1: policy, prompt and guard (docs and scripts only)

**1a. `docs/agent-efficiency/autonomous-pr-policy.md`, §Babysit skill family.** **Delivered** (`cursor/babysit-routing-phase1-b077`) — family row plus §Driver routing (single canonical table). No separate issue-pipeline subsection table.

**1b. `docs/agent-efficiency/github-issue-workflow-behaviour.md`, §Delivery contract.** **Delivered** (`cursor/babysit-pipeline-phase4-b077`) — obligation 4 uses §Driver routing rows 10–11 and R7 squash-merge end state; light-plan prose aligned.

Replace the current obligation 4 (remove `busy`) with the two obligations below. The old obligation 4 becomes 5 and is kept as written:

```markdown
4. keep `busy` while the PR it opened is open and a babysit driver (autonomous-pr-policy §Babysit skill family, issue-pipeline subsection) is working it. For `Method: PR` the end state is Pre-UAT green on the merge SHA, then DoD ticks and `finish-work`, as light-plan does (R7).
5. remove `busy` when finished, or set `Blocked` with a reason when it gives up.
```

**1c. `scripts/issue_pipeline_v2_launch.js`, `METHOD_PROMPTS.PR`.** **Delivered** (`cursor/babysit-pipeline-phase4-b077`).

Replace the empty string with:

```js
PR:
  'Delivery method: PR. After you open the PR, do not finish yet. Pick the driver from autonomous-pr-policy §Driver routing (rows 10–11; both `/babysit-plus`). ' +
  'Read `.cursor/skills/babysit-plus/SKILL.md` (or `.claude/skills/babysit-plus/SKILL.md` in Claude Code) and follow it to completion. Do not invoke it through the Skill tool. ' +
  'After squash merge, tick the DoD and run `finish-work`. Pre-UAT runs async in Actions.',
```

The prompt names the policy and the skill file. It does not restate the base-branch mapping, so the policy stays the only source of that rule (R4).

**Driver lifetime (must be settled in Phase 1).** `.github/workflows/pipeline-claude-run.yml` sets `timeout-minutes: 45`. A `babysit-uat` driver can wait for CI and reviews, merge, and then run the pre-UAT watch (up to 90 minutes) and up to three remedial rounds. It will not finish inside one run. Phase 1 therefore does not promise the full loop inside one run. When a driver cannot finish, it:

1. comments the next step on the PR and the issue (`Blocked` is not set),
2. leaves `busy` set on the issue,
3. hands the open PR to the Phase 3 fallback, which starts a new driver run.

Raising the timeout is a CI workflow change and needs the owner's approval. It is not part of Phase 1.

**1d. Dropped.** The line proposed for `scripts/pipeline_claude_prepare.js` was a checkbox that could invite a checkbox reading of R3. 1c already carries the instruction, and `finish-work` is the gate. No change to `pipeline_claude_prepare.js` in Phase 1.

**1e. `scripts/lib/babysit_skill_family_policy.js` and `scripts/check_babysit_skill_family.js`.** The guard checks literal and regex markers, not table rows. Add to `POLICY_MARKERS`:

- the literal heading `### Issue-pipeline delivery PRs`,
- a regex that matches the `main` row naming `/babysit-uat`,
- a regex that matches the integration row naming `/babysit-plus`.

Add a test next to `check_babysit_skill_family.test.js` that removing any of the three fails the check (R5).

**Docs gate for Phase 1:** `## Docs` lists `docs/agent-efficiency/autonomous-pr-policy.md` and `github-issue-workflow-behaviour.md`, because they describe a behaviour change.

### Phase 2: event-driven trigger (needs owner approval; design note **done**)

`.github/workflows/auto-babysit.yml` is a CI workflow change. `AGENTS.md` lists CI gate changes as requiring the owner's approval.

**Design note (delivered #2670).** `github-issue-workflow-behaviour.md` §Launch documents `purpose=babysit` launch records, `stage=babysit` on `pipeline-claude-run.yml`, and `METHOD_PROMPTS.PR` as the prompt. Record grammar and readers accept `purpose=babysit` and `stage=babysit`. **Remaining:** wire `auto-babysit.yml` to dispatch live babysit runs (not dry-run) for R1-scope PRs; owner approval required. Tracked: #2671.

- For PRs in the R1 scope, dispatch `pipeline-claude-run.yml` with the babysit purpose in place of the dry-run. The dispatch uses the base-branch rule.
- Other PRs keep the current dry-run.
- Skip fork PRs, since the pipeline token cannot act on them.

### Phase 3: engine fallback (needs owner approval, separate PR)

**Partially delivered** (`#2670`): `progress.babysit-fallback` launches `purpose=babysit` when a pipeline-authored open PR is idle for `babysitFallbackHours` (default 4). Copilot-thread-specific gating: #2672.

When a linked PR is open, has no active run and has an unresolved thread or a pending Copilot review for more than N hours, the engine rings the babysit doorbell (the same mechanism as the existing review and acceptance doorbells). This belongs in `github-issue-workflow-behaviour.md` §Transitions as a new row, and in the `issue_pipeline_v2_decide` code. N is a proposal for review. A starting point is 4 hours, which is less than the 24-hour stall rule.

## Acceptance criteria

1. A test pipeline PR gets a babysit run within one Phase 2 trigger cycle, verified by a dry run on a test branch.
2. A delivery run never ends with an unresolved thread and no `Blocked` reason.
3. Removing the pipeline subsection heading, or either base-branch row, fails `check_babysit_skill_family` (guard markers from 1e).
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
