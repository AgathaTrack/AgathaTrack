---
title: GitHub issue workflow — behaviour
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [documentation, github-issues, automation, pipeline-v2]
---
# Issue pipeline — behaviour

Stages, ownership, transitions, delivery contract, and acceptance gates for **pipeline v2**. Entry point: [github-issue-workflow.md](./github-issue-workflow.md). Wire format: [github-issue-workflow-wire.md](./github-issue-workflow-wire.md). Operations: [github-issue-workflow-operations.md](./github-issue-workflow-operations.md).

### Stored state

| Item | Kind | Values |
|------|------|--------|
| `Stage` | org issue field, **pipeline state** (not mirrored to/from Pawpet **Status**) | Backlog · To do · In analysis · Ready · In progress · In Main · In UAT · Done (case-insensitive; empty reads as Backlog) |
| Pawpet **Status** | project single-select, **board column** | Same column names as `Stage` on the engineering board; updated by humans and release automation; engine and agents use org `Stage` instead when reading lifecycle state |
| `Blocked` | org issue field | empty, or `question` · `no-convergence` · `launch-failed` · `decision` · `stalled` · `paused` · `sensitive` |
| `Attempts` | number | engine retry counter (reassignments, failed launches); reset on every `Stage` change |
| `busy` | label | an agent is actively working (delivery or a doorbell stage task) |
| `manual-only` | label | hand-driven: the engine never touches the issue (it takes no WIP slot) |
| body | issue body | the spec, then the agreed Delivery plan and Definition of Done |

The assignee is only a **doorbell** that starts an agent; no decision reads it. Agents are interchangeable and new ones
join by configuration.

### Who writes what

| Writer | `Stage` | `Blocked` | `Attempts` | `busy` | body | new issues |
|--------|---------|-----------|------------|--------|------|------------|
| Engine | yes | yes | yes | no | no | no |
| Agents (lane: spec, review, intent) | no | yes, when giving up or escalating | no | yes | yes | follow-up issues only, without `Stage` |
| **Analyse orchestrator** (`/analyse-issue`) | no (wakes the engine, which does intake) | no | no | no | no | no |
| Humans | yes | yes | no | yes | yes | yes |

This is a rule, not a permission: agent tokens can write org issue fields. **Bootstrap:** until the engine runs in `on`
mode an agent may move `Stage` for a transition it has satisfied, citing the table row and the evidence in a comment.
From `on`, only the engine writes `Stage`: To do → In analysis → Ready, delivery and release, and the Backlog → To do analyse intake under `mission=analyse` (PIPE-V2-D-ANALYSE-003, revised 2026-11-26). A human hold in `Blocked` means a human is needed; the engine clears only its own engine holds (`stalled`, `launch-failed`) when their cause is gone (§Transitions, Holds).

**Merge, UAT and prod handlers (#2394 AAT).** While the engine is not `on` for an issue, the legacy handlers write `Stage` under the same table conditions: `In Main` only when the Definition of Done is ticked, no linked PR is still open, and a linked PR merged into `main` (`mayEnterInMain`); `In UAT` only when the issue's Stage is already `In Main` (an empty Stage keeps the legacy behaviour); `Done` with the prod close. A merge that does not complete the table leaves the issue `In progress`, so a two-PR issue reaches In Main after its last merge.

The issue-fields `PATCH` replaces an issue's whole value set, so every engine write sends the values the issue already holds
(`buildIssueFieldPatch` / `withCurrentValues`); a write of `Attempts` alone would remove `Stage` and `Blocked`. Agents patching fields by hand do the same.
Before a live field write, `applyAction` and migration re-read the issue so values changed during doorbell or launch are not overwritten by the tick-start snapshot.

**One writer per issue.** While `ISSUE_PIPELINE_V2=on` (within `ISSUE_PIPELINE_V2_LABEL` when it is set), the legacy
merge, UAT and prod handlers skip the issues the engine owns. Left running they would
move `Status` after the *first* merged PR, remove `busy` and reopen.
`on` without a valid engine identity ends the tick red, because the legacy writers have already stepped aside.

### Transitions

Every transition is a field write. Today a tick takes one action per issue; that is how the runner works now, not a
rule (PIPE-V2-D-TICK-001). The planned tick changes are in
[changes/pipeline-v2-holds-and-ticks.md](./changes/pipeline-v2-holds-and-ticks.md).

| Stage | Condition | Result |
|-------|-----------|--------|
| To do | spec requested from the next tier-a agent in the round robin (`cursor-a`, `claude-a`; tier b waits for the challenge tier); the agent drafts the sections and the Definition of Ready passes (a signed `spec up` verdict on the body; reactions are not votes) | → In analysis |
| To do | no spec result after every agent timed out once (30 min each) | stays, `Blocked=stalled` |
| In analysis | one verified green on the current body hash from a pool identity, from a run other than the one that wrote the hash (PIPE-V2-D-REV3-003, live with REV3-012) | → Ready |
| In analysis | 6 signed verdicts and agent body edits without convergence | stays, `Blocked=no-convergence` |
| In analysis | no vote after every eligible reviewer timed out | stays, `Blocked=stalled` |
| Ready | a WIP slot is free (WIP is a slot count, not the Stage column: each issue counts once, as an In progress issue the engine launched, or as a Ready issue with a delivery launch in flight (`busy`, or started inside the ack window); hand-driven and `manual-only` work takes no slot, and an unreadable issue holds one): the engine starts a run for the agreed method | → In progress once the issue is `busy` |
| Ready | WIP at the limit | stays (Ready is the queue) |
| Ready | a `risky scope detected` launch failure (the v2 launch no longer produces it, PIPE-V2-D-REV4-004) | stays, `Blocked=sensitive` on the next tick until the owner clears it; no launch backoff |
| Ready | start failed after 3 retries on the backoff, or a run without `busy` after the acknowledge window counts as a failed start | stays, `Blocked=launch-failed` |
| In progress | Definition of Done ticked, no open linked PR, at least one linked PR merged into `main`, `busy` released | → In Main. Intent review is requested unless `aat.enabled` is on, both acceptance fields exist, and the issue is not a follow-up |
| In progress | the newest actionable acceptance verdict for the latest merge into `main` is `fail` with `reason=scope` or `reason=implementation` (`aat.enabled`, both fields, not a follow-up) | stays. `scope` relaunches delivery once; `implementation` waits for a follow-up whose body starts with this issue's marker, or for a linked PR. Neither sets `Blocked` while that work is still open. A newer merge into `main` ends the hold |
| In progress | umbrella (an issue with GitHub sub-issues, PIPE-UMB-D-001): a sub-issue is not In Main, In UAT or Done (one closed as not planned is ignored) | stays, `progress.umbrella-waiting`, and the blockers are logged. Checked before the In Main move |
| In progress | `busy` gone early or 24 h without activity | one resume (relaunch), then `Blocked=stalled`; issues the engine did not launch are never resumed. A resume that fails to start does not use the one resume: it is retried on the launch backoff, then `Blocked=launch-failed`. Not taken while a scope or implementation acceptance fail still holds |
| In Main | `aat.enabled` is off, or an acceptance field is missing, or the issue is a follow-up: an agent that did not author the PRs reviews what shipped against the issue's intent (does not gate) | stays |
| In Main | umbrella: a sub-issue is not In Main, In UAT or Done | stays, `main.umbrella-waiting`. Checked before intent review, acceptance and the UAT check, so none of them runs for it |
| In Main | that same flag-off path, and the newest successful `deploy-uat.yml` run's commit contains the latest merge into `main` | → In UAT |
| In Main | `aat.enabled` is on, both fields exist, and the issue is not a follow-up | acceptance must pass for the latest merge into `main` (`aatSatisfied`) and that merge must be in the newest successful UAT deploy. No intent-review doorbell |
| In UAT | the newest successful `deploy-prod.yml` run's commit contains it | → Done, issue closed, `in-prod` added |
| none | a follow-up (see below) of depth 1 or 2 | → To do; deeper → Backlog |
| In progress / In Main / In UAT | the issue was closed (as completed) before Done, for example by a merge | reopened once (`v2:reopened` comment); a second close, a `not_planned` close and a `manual-only` issue are left alone |
| any | an AGENTS.md escalation item is hit | stays, `Blocked=decision` |
| any | `Blocked` is an engine hold (`stalled`, `launch-failed`) and the stage rule, re-run on full facts, no longer ends in an engine hold (a newer merge, a late vote, a merged PR, an agent back at work) | the engine clears `Blocked` (`v2:release by=engine`); the stage rule acts on the next tick |
| any | a human clears an engine hold | a retry: the engine records `v2:release by=human`, and the stage's earlier attempts stop counting |
| any | a human changes `Stage` or clears `Blocked` | as set |

**Holds (PIPE-V2-D-HOLD-001 to 005).** `Blocked` carries two kinds of value:

- **Human holds** (`question`, `decision`, `no-convergence`, `sensitive`, `paused`): a human must act. The engine
  re-evaluates nothing. Its only action is waking the stage agent once per new human comment (a user with write access
  who is not a listed agent). `paused` and `sensitive` are owner holds: a comment wakes nobody until the owner clears
  them. To hold an issue by hand, use `paused`.
- **Engine holds** (`stalled`, `launch-failed`): the engine ran out of retries. Each tick it reads the issue in full,
  re-runs the stage rule as if unblocked, and clears the flag itself when the rule no longer ends in an engine hold. While
  the rule still ends in one, a human comment wakes the stage agent as for a human hold. Setting one posts
  `<!-- v2:hold reason=… row=… -->`. When the rule is only waiting on launch backoff, re-evaluation clears `Blocked` even
  though the issue does not launch until the backoff elapses (the field is not a wait indicator).
- **A human clear of an engine hold is a retry.** The next tick posts `<!-- v2:release by=human -->`; an engine release
  posts `by=engine`. Attempt markers older than the newest release stop counting: `v2:spec-request` in To do,
  `v2:resume` and `v2:aat-relaunch` in In progress, `v2:aat-launch` in In Main. In analysis, a release newer than the
  last review request drops that round's earlier silent attempts, so the round gets one more attempt. Ready restarts its
  count because a release writes `Attempts=0`. A release also restarts the `stalledInactivityHours` quiet clock for the
  acceptance holds, so a retry is not stalled again at once. A hold set before this change has no `v2:hold` marker, so clearing it is
  not seen as a retry; the engine still releases it when the cause changes.
- **Infrastructure faults do not use a budget.** An acceptance launch, a scope relaunch or a resume that fails to start
  is retried on `limits.launchBackoffMin` (5, 30, 120 min), then becomes `Blocked=launch-failed`. Only a run that
  started and produced nothing usable counts toward `aat.maxInconclusive` or the one resume. A doorbell that fails to
  ring in To do or In analysis still counts as that agent's attempt (see the change doc).
- **No launchable agent is a board-level error.** Ready, In progress resume, acceptance and scope relaunch report
  `no launchable agent (<row>) for issues #…` once per run and end the run red; nothing is written on the issues.

### Delivery contract

A delivery agent, whatever the method, must:

1. set `busy` when it starts (the engine sets it at launch; the agent keeps it while it works);
2. reference the issue as `Refs #n` in **every** PR it opens, never `Closes` / `Fixes` / `Resolves` (those auto-close the
   issue on merge; an issue must stay open through UAT and prod), including the release PR of a light-plan;
3. tick the **delivery** Definition of Done as items land (mergeable work and automated verification only — **not** live board soaks; see [soak-testing.md](./soak-testing.md). Unticked rows that **start** with `<!-- soak-dod:defer -->` do not block `progress.finished` — `dodComplete` in `issue_pipeline_v2_release.js`);
4. remove `busy` when finished, or set `Blocked` with a reason when it gives up.

A PR is linked to an issue when its body says `Refs|Closes|Fixes|Resolves #n` and it appears in the issue's timeline. Only
merges into `main` count; phase PRs merged into an integration branch are open or closed work, not delivery.

**Light-plan programmes** (body `Method: light-plan`, skill: `.cursor/skills/light-plan/SKILL.md`): the delivery agent ends
at Pre-UAT green on the release merge SHA — every **delivery** Definition of Done item ticked (live soaks excluded per [soak-testing.md](./soak-testing.md)), then `finish-work`. It does **not** close
the issue or run **`/AgentAcceptance`** (the acceptance skill forbids the session that shipped the release). While the engine
**owns** the issue (`v2Owns` in `pipeline-v2-owner.js`: `ISSUE_PIPELINE_V2=on` and no soak scope label, or the issue carries
`ISSUE_PIPELINE_V2_LABEL` when set), the delivery agent does **not** write **`Stage`**; **bootstrap** (engine off, dry-run, or
unscoped soak without the label) follows the §Who writes what bootstrap row instead. With ownership on, the engine advances
**`Stage`**: **In progress → In Main** when `progress.finished` facts hold; the issue stays **In Main** through the
**agent acceptance gate** (`launch-aat` → `aatSatisfied` when enabled); **In Main → In UAT** only after gate satisfaction **and**
`uatContainsLatestMerge` — not on merge alone. Legacy merge/UAT handlers still set **`Stage`** when the engine does not own the
issue (`ownedByV2Engine` in `issue-agent-handlers.js`).

### Launch and intent review

- **Launch:** the engine starts a Cursor run through `launch-cursor-agent.js` for agents whose runner is in `launchRunners`,
  with the method's skill procedure appended to the prompt. It records `v2:launch-pending` before the handoff, then `v2:launch`
  (run id) after it, or `v2:launch-failed`; `v2:launch-acked` follows the agent's busy report. `Attempts` holds the failed-run
  count. A pending record with no `busy` label is one failed start (the handoff never happened). An issue that is already
  `busy` is never launched again.
- **Intent review:** `v2:intent-review agent=<login> merge=<sha>` asks an agent that did not author the linked PRs to review
  the merged change against the issue's original intent (skill: `.cursor/skills/intent-review-agent`). Each finding becomes a
  new issue attached as a GitHub sub-issue of #n and starting `<!-- v2:follow-up of=#n -->`, without `Stage`. The engine counts the chain depth from the parents'
  bodies and puts depth 1–2 in To do, deeper in Backlog. A review counts for one merge; a later merge needs its own.
  When `aat.enabled` is on and both `Acceptance` and `Acceptance fail reason` exist, a non-follow-up does not get this
  doorbell: that check is part of agent acceptance. Follow-ups still get it. If either field is missing, the tick logs
  `acceptance.field-missing` once and keeps this doorbell. In `.github/pipeline-agents.json`, `aat.enabled` is true (Refs #2448). The flag stays true if a field later disappears; the acceptance gate is active only while both org fields are present.

### Blocked reasons

| Reason | Kind | Stage | Cleared by |
|--------|------|-------|-----------|
| `question` | human | To do | human reply (the agent re-checks and clears) |
| `no-convergence` | human | In analysis | owner decision (comment or body edit) |
| `decision` | human | any | owner answer |
| `launch-failed` | engine | Ready, In progress (resume), In Main (acceptance launch, scope relaunch) | the engine, when the stage rule no longer ends in a hold; or a human clear, which is a retry |
| `stalled` | engine | To do, In analysis, In progress, In Main | the engine, when the stage rule no longer ends in a hold; or a human clear, which is a retry |
| `paused` | human (owner) | any | the owner sets and clears it |
| `sensitive` | human (owner) | Ready (legacy risky preflight) | owner clears `Blocked`, fixes the body or adds `owner-approved-delivery` and retries; or runs delivery manually |

### Labels (v2)

| Label | Meaning |
|-------|---------|
| `busy` | a delivery agent is working on the issue; do not start a second run |
| `queued` | the engine could not start the assigned runner (Claude WIP cap); retry on the next tick; spec/review agents clear it via `clear-queued` at session start (keeps `busy`); `finish-work` clears both when ending work |
| `manual-only` | hand-driven; the engine and autonomous implementation never touch it |
| `needs-owner` | only on execute-plan control issues, where the runtime reads it; not an issue-pipeline state |
| `in-prod` | added by the engine when an issue reaches Done |
| `bug` / `feature` / `task` | issue form type; the Definition of Ready is checked per form |
| `AAT-progress` / `AAT-passed` / `AAT-failed` | Agent Acceptance (`/AgentAcceptance`); see [github-labels.md](./github-labels.md) |

### Umbrella issues (PIPE-UMB-D-001)

An **umbrella** is an issue that has GitHub sub-issues. Its own delivery is still tracked by its own PRs, but its **Stage** follows its sub-issues:

- It moves **In progress → In Main** and **In Main → In UAT** only when **every** sub-issue is at **In Main**, **In UAT** or **Done**. A sub-issue closed as *not planned* is not a blocker. A sub-issue with an empty Stage counts as Backlog and blocks.
- A `Refs #n` link from a pull request does **not** move an umbrella on its own. The link still counts for the umbrella's own merges and open PRs, but the Stage move is decided by the rollup. The Refs-versus-Closes split for Done (#2363 §5.1) is unchanged.
- The rollup never moves an umbrella backwards. If a sub-issue regresses after the umbrella is In Main, the umbrella stays where it is and the engine logs the blockers.
- A sub-issue list or stage that cannot be read **fails closed**: nothing moves, and the error is logged.
- The **engine** (`ISSUE_PIPELINE_V2=on`) re-evaluates the umbrella on every tick, so it moves as soon as the last sub-issue reaches In Main. The **legacy handlers** only block: they check the same rule at merge and UAT, but nothing re-runs them when a sub-issue later moves, so the umbrella then needs the engine or a manual move.
- Implementation: `scripts/issue_pipeline_v2_umbrella.js` (rule and readers), `decideInProgress` and `decideInMain` in `scripts/issue_pipeline_v2_decide.js`, and `umbrellaClear` in `.github/scripts/issue-agent-handlers.js`. Tests: `scripts/issue_pipeline_v2_umbrella.test.js` and the umbrella case in `.github/scripts/issue-agent-handlers.test.js`.

### Agent acceptance (`/AgentAcceptance`)

Holistic acceptance on a **parent** issue. With `aat.enabled` false it stays human- or agent-invoked and does not gate In UAT. With `aat.enabled` true (the repo config since #2448 P4) and both org fields present, it is the engine's blocking gate from **In Main** to **In UAT** for issues that are not follow-ups: `aatSatisfied` for `delivery.lastMergeSha` and `uatContainsLatestMerge` are both required. Follow-ups keep intent review. The production-deploy guard stays on #2424.

1. **Eligibility:** Parent issues only — not bodies with `<!-- v2:follow-up of=#n -->`.
2. **Labels:** human-facing; `aat-start` ensures labels and sets `AAT-progress`; `aat-pass` / `aat-fail` update labels after the comment (REST via `github_issue_workflow.js`, not `gh issue edit`). The engine does not read the labels. **Token:** `GH_TOKEN` or `PAWPET_CLAUDE_TOKEN` in agent sessions. Agents never write `Stage`, `Acceptance`, or `Acceptance fail reason`.
3. **Verdict record:** last line of the verdict comment, `<!-- v2:aat verdict=pass|fail|inconclusive merge=<sha> -->`. A fail includes `reason=scope|implementation|quality`. Pass and inconclusive omit `reason`. `inconclusive` is a verdict, not a reason. A fail without a known reason is ignored. Only a listed agent's comment newer than the engine's latest `v2:aat-launch` for that merge counts.
4. **INCONCLUSIVE and timeout** share `aat.maxInconclusive` per merge, then `Blocked=stalled` while the issue stays In Main. A launch still inside `aat.timeoutMin` is not relaunched. A timeout is not a fail. A launch that failed to start (`v2:aat-launch … failed=1`) is not an attempt: it is retried on the launch backoff, then `Blocked=launch-failed`. A newer merge releases either hold (§Holds). Verdicts are compared to the latest launch that started.
5. **Fail paths:** `quality` stays In Main until a newer linked merge into `main`. `scope` and `implementation` return to In progress and stay there until a newer linked merge into `main`. `scope` relaunches delivery once on the existing programme. `implementation` is a `bug` follow-up (`<!-- v2:follow-up of=#parent -->`, `Priority=Urgent` when that field exists) whose PRs also `Refs` the parent. Neither sets `Blocked` while a linked PR is open or, for implementation, while such a follow-up is open.
6. **Waiver:** a human `Manual` or `Skipped` is bound with `v2:aat-waive` for one merge. `Manual` is cleared when the latest merge changes. `Skipped` stays, and the new merge gets its own waive. A bound waiver is not overwritten by a pass or a newer fail.
7. **Checks:** Original intent (summary, acceptance criteria, Definition of Done) and behaviour on `main` at the merge SHA. `scope` means a stated criterion or planned phase has no merged implementation. `implementation` means the work was attempted and the behaviour on `main` is wrong. `quality` means the behaviour matches and only small fixes remain; those still block In UAT. A pass means nothing has to merge before In UAT.

Skill: [`.cursor/skills/agent-acceptance/SKILL.md`](../../.cursor/skills/agent-acceptance/SKILL.md).

### Production-deploy acceptance guard ([#2424](https://github.com/AgathaTrack/AgathaTrack/issues/2424))

After UAT is green and before `deploy-prod` runs, **`scripts/ci/aat-prod-gate.js`** blocks promotion when an engine-owned merge in the promoted SHA still lacks a satisfying acceptance verdict. The rules are shared with the In Main gate (#2448) via `scripts/issue_pipeline_v2_acceptance.js` (`aatGateOn`, `deriveAatState`, `aatSatisfied`, `newestActionable`), so the engine and the prod workflow cannot disagree.

| Control | Where | Meaning |
|---------|-------|---------|
| `AAT_GATE` | repo variable | unset / `off` (default): no API calls, step passes. `dry-run`: job summary lists would-block merges, never fails deploy. `on`: fails `resolve-trigger` when any gated merge is unsatisfied. Unknown values run as `dry-run`. |
| `aat.enabled` | `.github/pipeline-agents.json` | When `false`, the guard makes no API calls. When `true` (repo config since #2448 P4) but either org field `Acceptance` / `Acceptance fail reason` is missing, it may call **`loadOrgFields` only** (field definitions), then returns without reading issues or blocking. Full reads and blocking need both fields present and `AAT_GATE` `dry-run` or `on` (with token). |
| `AAT_GATE_READ_TOKEN` | repo secret | Read-only token for issue and org Projects field reads. **Required** in `dry-run` and `on`. There is no fallback to workflow `GITHUB_TOKEN` (it cannot read the board fields). `ENGINE_PAT` is never passed to `deploy-prod.yml`. |
| `aat_override_reason` | `deploy-prod` `workflow_dispatch` input | When set by a login in repo variable **`AAT_OVERRIDE_ACTORS`**, an `on` gate passes and the reason is recorded in the job summary. Automatic UAT dispatch never sets it. |

**Gated set:** parent issues in `In Main` or `In UAT` whose latest merge is an ancestor of the promoted SHA; `In progress` issues whose newest actionable verdict for that merge is a `scope` or `implementation` fail; follow-ups and `manual-only` issues are exempt. Honour `ISSUE_PIPELINE_V2_LABEL` while it is set.

**Enablement (owner):** add `AAT_GATE_READ_TOKEN`, set `AAT_GATE=dry-run`, soak one promotion, then `AAT_GATE=on` when ready. Full promotion flow: [promotion-contract.md](../pipelines/promotion-contract.md) (§Prod deploy behaviour).
