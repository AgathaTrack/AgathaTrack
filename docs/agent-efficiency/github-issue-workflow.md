---
title: GitHub issue workflow
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-21
tags: [documentation, github-issues, automation]
---
# GitHub issue workflow

This document describes how issues are filed, triaged, and moved through delivery for Agatha Track.

It covers two layers:

- **Issue pipeline v2** (shipped behind `ISSUE_PIPELINE_V2`): the org field `Stage` is the board column and the only state; an engine moves issues through eight stages. See [§Pipeline v2](#pipeline-v2-the-stage-machine). Plan of record: [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). The earlier assignee-driven design ([plans/issue-pipeline-automation.md](./plans/issue-pipeline-automation.md), [plans/issue-pipeline-dispatcher-spec.md](./plans/issue-pipeline-dispatcher-spec.md)) is superseded.
- **Legacy label flow** (the old engine and `ISSUE_PIPELINE`, until it is removed): the `human-reviewed` label triggers deterministic triage, `agent-approved` triggers Cursor dispatch. See [§Live workflow (legacy)](#live-workflow-legacy-until-issue_pipelineon).

## Issue forms

Issue intake uses GitHub Issue Forms in [`.github/ISSUE_TEMPLATE/`](../.github/ISSUE_TEMPLATE/). Blank issues are disabled; contributors must choose a form.

| Form | File | Purpose |
|------|------|---------|
| Bug | `bug.yml` | Report incorrect or broken behavior with reproduction steps and environment details. |
| Feature | `feature.yml` | Request a new capability or enhancement with problem statement and acceptance criteria. |
| Task | `task.yml` | Track internal engineering or maintenance work with scope and definition of done. |

New issues from these forms receive type labels (`bug`, `feature`, or `task`) and `needs-triage`.

**Legacy issues:** Issues created before these forms were introduced are not automatically normalized. They may need manual enrichment to match the fields expected by triage and future automation.

## Pipeline v2: the Stage machine

An issue moves through eight stages by agent work alone, except where a human is needed. The only state is stored on the
issue; everything else (votes, linked PRs, Definition of Done progress, run liveness, deployments) is read from GitHub on
every tick. Plan of record: [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). Code: `scripts/issue_pipeline_v2*.js`
(a pure `decide(facts, config)` plus thin readers and one action executor).

### Switches and identity

| Setting | Where | Meaning |
|---------|-------|---------|
| `ISSUE_PIPELINE_V2` | repo variable | `off` (default; the job does not run), `dry-run` (decides and logs, sends nothing), `on` (writes). Separate from the legacy `ISSUE_PIPELINE`. |
| `ISSUE_PIPELINE_V2_LABEL` | repo variable | Optional soak scope, e.g. `pipeline-beta`. In `on` mode only issues with this label are written to; all others are still decided and logged as dry-run. |
| `WIP_LIMIT` | repo variable | Temporary. `off` lifts the Ready queue cap (`limits.wip`) for every tick, so Ready issues launch without waiting for a free slot. Any other value, or unset, keeps the committed limit. Remove the variable to restore it. |
| `engine.logins` | `.github/pipeline-agents.json` | The account(s) the engine writes as (`pawpet-engine`, secret `ENGINE_PAT` / `GH_PROJECTS_PAT` on the v2 tick). It is never a listed agent. With no matching token the tick runs as a dry run whatever the variable says. |
| `agents`, `limits`, `launchRunners`, `aat` | `.github/pipeline-agents.json` | Pool members: each entry has a logical **`id`** (rotation, timeouts, markers), an **`actsAs`** GitHub login (assignee, `@mention`, reactions), optional **`model`**, **`runner`**, and **`methods`**. Legacy rows with **`login` only** use that login as both `id` and `actsAs`. `engine.logins` must not match any `actsAs`. Limits and `launchRunners` as before. `aat` is `enabled` (boolean; true in this repo), `timeoutMin`, and `maxInconclusive`. A bad edit fails in CI. |

The workflow [`issue-pipeline-v2.yml`](../../.github/workflows/issue-pipeline-v2.yml) runs at :11 and :41 and on manual dispatch.
Each issue gets one action per tick, logged as a `pipeline_v2_action` line; the tick line reports `errors`.

### Stored state

| Item | Kind | Values |
|------|------|--------|
| `Stage` | org issue field, **is the board column** | Backlog · To do · In analysis · Ready · In progress · In Main · In UAT · Done (case-insensitive; empty reads as Backlog) |
| `Blocked` | org issue field | empty, or `question` · `no-convergence` · `launch-failed` · `decision` · `stalled` · `paused` |
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
| Agents | no, except during bootstrap | yes, when giving up or escalating | no | yes | yes | follow-up issues only, without `Stage` |
| Humans | yes | yes | no | yes | yes | yes |

This is a rule, not a permission: agent tokens can write org issue fields. **Bootstrap:** until the engine runs in `on`
mode an agent may move `Stage` for a transition it has satisfied, citing the table row and the evidence in a comment.
From `on`, only the engine writes `Stage`. `Blocked` set means a human is needed; the engine never clears it.

**Merge, UAT and prod handlers (#2394 AAT).** While the engine is not `on` for an issue, the legacy handlers write `Stage` under the same table conditions: `In Main` only when the Definition of Done is ticked, no linked PR is still open, and a linked PR merged into `main` (`mayEnterInMain`); `In UAT` only when the issue's Stage is already `In Main` (an empty Stage keeps the legacy behaviour); `Done` with the prod close. A merge that does not complete the table leaves the issue `In progress`, so a two-PR issue reaches In Main after its last merge.

The issue-fields `PATCH` replaces an issue's whole value set, so every engine write sends the values the issue already holds
(`buildIssueFieldPatch` / `withCurrentValues`); a write of `Attempts` alone would remove `Stage` and `Blocked`. Agents patching fields by hand do the same.
Before a live field write, `applyAction` and migration re-read the issue so values changed during doorbell or launch are not overwritten by the tick-start snapshot.

**One writer per issue.** While `ISSUE_PIPELINE_V2=on` (within `ISSUE_PIPELINE_V2_LABEL` when it is set), the legacy
merge, UAT and prod handlers and the Stage ↔ Status mirror skip the issues the engine owns. Left running they would
move `Status` after the *first* merged PR, remove `busy` and reopen, and the mirror would copy that into `Stage`.
`on` without a valid engine identity ends the tick red, because the legacy writers have already stepped aside.

### Transitions

One action per issue per tick; every transition is a field write.

| Stage | Condition | Result |
|-------|-----------|--------|
| To do | spec requested from the next startable agent in the round robin; the agent drafts the sections and the Definition of Ready passes (a 👍 on the request) | → In analysis |
| To do | no spec result after every agent timed out once (30 min each) | stays, `Blocked=stalled` |
| In analysis | the last body editor (if an agent) plus one other agent 👍 the current body hash; two agents if a human edited last. An edit by a login several ids share counts as an agent edit only with a verified `edit` claim; unclaimed, it is a human edit and needs two distinct ids | → Ready |
| In analysis | 6 votes (👍, 👎, agent body edits) without convergence | stays, `Blocked=no-convergence` |
| In analysis | no vote after every eligible reviewer timed out | stays, `Blocked=stalled` |
| Ready | a WIP slot is free (WIP counts In progress issues the engine launched; hand-driven and `manual-only` work takes no slot): the engine starts a run for the agreed method | → In progress once the issue is `busy` |
| Ready | WIP at the limit | stays (Ready is the queue) |
| Ready | start failed after 3 retries on the backoff, or a run without `busy` after the acknowledge window counts as a failed start | stays, `Blocked=launch-failed` |
| In progress | Definition of Done ticked, no open linked PR, at least one linked PR merged into `main`, `busy` released | → In Main. Intent review is requested unless `aat.enabled` is on, both acceptance fields exist, and the issue is not a follow-up |
| In progress | the newest actionable acceptance verdict for the latest merge into `main` is `fail` with `reason=scope` or `reason=implementation` (`aat.enabled`, both fields, not a follow-up) | stays. `scope` relaunches delivery once; `implementation` waits for a follow-up whose body starts with this issue's marker, or for a linked PR. Neither sets `Blocked` while that work is still open. A newer merge into `main` ends the hold |
| In progress | `busy` gone early or 24 h without activity | one resume (relaunch), then `Blocked=stalled`; issues the engine did not launch are never resumed. Not taken while a scope or implementation acceptance fail still holds |
| In Main | `aat.enabled` is off, or an acceptance field is missing, or the issue is a follow-up: an agent that did not author the PRs reviews what shipped against the issue's intent (does not gate) | stays |
| In Main | that same flag-off path, and the newest successful `deploy-uat.yml` run's commit contains the latest merge into `main` | → In UAT |
| In Main | `aat.enabled` is on, both fields exist, and the issue is not a follow-up | acceptance must pass for the latest merge into `main` (`aatSatisfied`) and that merge must be in the newest successful UAT deploy. No intent-review doorbell |
| In UAT | the newest successful `deploy-prod.yml` run's commit contains it | → Done, issue closed, `in-prod` added |
| none | a follow-up (see below) of depth 1 or 2 | → To do; deeper → Backlog |
| In progress / In Main / In UAT | the issue was closed (as completed) before Done, for example by a merge | reopened once (`v2:reopened` comment); a second close, a `not_planned` close and a `manual-only` issue are left alone |
| any | an AGENTS.md escalation item is hit | stays, `Blocked=decision` |
| any | a human changes `Stage` or clears `Blocked` | as set |

A blocked issue's only action is waking its stage agent once per new human comment (a user with write access who is not a
listed agent); the engine never clears the flag. `paused` is the owner's hold: a comment wakes nobody until the owner
clears it.

### Review: votes and the markers

- **Spec and review requests** are engine comments with a hidden marker: `v2:spec-request` and `v2:review-request hash=<hash>`
  store the assigned agent **id** and who timed out; the visible line `@mentions` the agent's **`actsAs`** login. A reassignment edits the comment in place. A review request is posted on
  entering In analysis and on each new body hash. Intent review markers store `agent=<id>` the same way.
- **Votes** are 👍/👎 reactions by listed agents on the request comment for the current hash when each pool id has a distinct
  `actsAs` login. When several ids share one GitHub login, reactions cannot name the voter: those agents post signed
  `<!-- v2:verdict ... -->` comments via `node scripts/pipeline_verdict.js` using `PIPELINE_RUN_SECRET` from the doorbell
  launch (the engine keeps `PIPELINE_VOTE_KEY` and verifies signatures; reactions are ignored for that pool). The owner's
  reactions do not count. The last body editor's edit counts as its approval. A signed verdict counts only when its
  signature verifies, the comment author is the id's `actsAs`, its nonce belongs to an engine launch record for that id
  and stage, it was **posted** (comment time, not the tick that reads it) within `reviewTimeoutMin` of that launch, its
  kind fits the launch stage (`spec` in To do; `review` / `edit` in In analysis), its hash is the current body hash, and
  it is the id's first verdict of that kind on that hash. An `edit` claim also needs the newest body edit to be by the
  id's `actsAs` and to be no later than the claim (`claim.created_at >= editedAt`), so a later same-login revert does not
  credit an older claim.
- **Delivery plan:** the method (`PR`, `light-plan` or `execute-plan`, read from the body's `Method:` line, default `PR`),
  the planned work, the `agent-paths` block and the Definition of Done are written into the body during review. After
  convergence the body is frozen except for Definition of Done ticks.
- **Doorbell run:** when the engine posts, reassigns or wakes a spec, review or intent-review request for an agent whose
  runner is in `launchRunners` (`cursor` and/or `claude`), it also starts a run with the stage's task (Cursor via the
  Agents API; Claude via `pipeline-claude-run.yml` workflow dispatch with `run-name: pipeline-claude-<nonce>`). Spec pass in To do,
  adversarial review in In analysis, intent review in In Main). The run is not a delivery (no PR) and skips the legacy
  launch preflight; the launcher sets `busy` like a delivery handoff (except the non-interactive **acceptance** doorbell).
  The engine removes `busy` when the stage advances (spec → In analysis, review → Ready) or when it sets `Blocked`.
  A `busy` doorbell holds a timed-out pickup for one more `reviewTimeoutMin` at most, then the pickup moves on, so a run
  that ends without a result cannot hold the issue for good. The Claude workflow fails its job when the run left no
  comment and no reaction on the issue since it started (`scripts/pipeline_claude_verify.js`); a failed job is
  `status() === 'failed'`, so the next live tick reassigns at once. Its prompt names the request comment id and the exact
  `gh api` reaction command, and the Claude step gets `GH_TOKEN`;
  intent-review agents remove it with `node scripts/github_issue_workflow.js finish-work --issue <n>` when done. With too
  little information it writes a best-effort spec,
  asks its question in a comment and sets `Blocked=question`; with enough it writes the full spec (delivery plan, paths,
  Definition of Done) and signs spec pass (`pipeline_verdict.js spec up`, or 👍 on the request when `actsAs` logins are
  unique), so the engine moves the issue to In analysis. A failed start is only logged;
  the pickup timeout reassigns. Delivery launches do not use the `claude` runner (doorbell only). Every pickup (spec, review, intent review, wake, and the last editor asked to revise) goes only to agents whose runner is in `launchRunners`. An assignee outside that set is reassigned on the next tick, without waiting out the timeout; a wake rings the holder only when that holder is startable, and does nothing when no startable agent is left. When none is left for a new request, To do and In analysis set `Blocked=stalled` and intent review is skipped. Assignment is one round robin over those startable agents, in config order. With no engine launch on the board yet, the first assignment is the first startable agent. Every later assignment — the next pickup on that issue, or the first pickup on another issue — is the next agent in the ring, wrapping. The cursor is the newest engine `v2:launch` on the board. Assignments already chosen earlier in the same tick move it, and only an in-scope decision does, so several fresh issues in one tick do not all land on the same agent. A timeout reassignment takes the next agent who is still eligible. Nothing new is stored. The full `agents` list still counts for votes and convergence.
- **Launch preflight:** a delivery launch (Ready, and the one resume) still runs the legacy safety preflight
  (`.github/scripts/agent-safety-lib.js`): the risky-scope and blocking-label (`busy`, `manual-only`, `blocked`) checks
  stand; an issue waiting on a human has `Blocked` set, which the engine never launches. Its `agent-approved` and `human-reviewed` label requirements are retired under v2, where a
  converged review and Ready are the approval, so the engine supplies those two labels to the check itself. A refusal
  records `v2:launch-failed` with the reason and counts as a failed start.
- **Tick log:** each tick logs `pipeline_v2_action` before applying an action and `pipeline_v2_applied` after, with what
  was done (`launch:`, `launch-failed:`, `doorbell:`, `doorbell-failed:<agent>:<reason>`, comments, writes). When the
  action was not written (dry-run mode, no engine identity, or outside the scope label) it logs `pipeline_v2_planned`
  with the same list instead, so a log line never claims a write that did not happen.

### Delivery contract

A delivery agent, whatever the method, must:

1. set `busy` when it starts (the engine sets it at launch; the agent keeps it while it works);
2. reference the issue as `Refs #n` in **every** PR it opens, never `Closes` / `Fixes` / `Resolves` (those auto-close the
   issue on merge; an issue must stay open through UAT and prod), including the release PR of a light-plan;
3. tick the Definition of Done as items land;
4. remove `busy` when finished, or set `Blocked` with a reason when it gives up.

A PR is linked to an issue when its body says `Refs|Closes|Fixes|Resolves #n` and it appears in the issue's timeline. Only
merges into `main` count; phase PRs merged into an integration branch are open or closed work, not delivery.

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

| Reason | Stage | Cleared by |
|--------|-------|-----------|
| `question` | To do | human reply (the agent re-checks and clears) |
| `no-convergence` | In analysis | owner decision (comment or body edit) |
| `decision` | any | owner answer |
| `launch-failed` | Ready | owner fixes the cause, clears |
| `stalled` | To do, In analysis, In progress | owner checks, clears |
| `paused` | any | the owner sets and clears it |

### Operating it

- **Lifting the WIP cap:** `WIP_LIMIT=off` (see the switches table) only changes the Ready gate. In `on` mode it still
  writes only to issues matching `ISSUE_PIPELINE_V2_LABEL`, but with the cap off every matching Ready issue launches on
  the next tick. Set it back or remove it when the soak is done.
- **Dry run:** set `ISSUE_PIPELINE_V2=dry-run` (or dispatch the workflow) and read the `pipeline_v2_action` lines and the
  tick summary. Check that nothing acts on hand-driven issues (label them `manual-only`).
- **Migration (once):** dispatch [`issue-pipeline-v2-migrate.yml`](../../.github/workflows/issue-pipeline-v2-migrate.yml)
  as a dry run, read the `pipeline_v2_migrate` lines, then dispatch with `apply`. It gives each open board issue a `Stage`
  (from the board column, else Backlog) and a `Blocked` reason from the legacy `question` / `needs-owner` labels.
- **Soak:** `dry-run` for a day; then `on` with `ISSUE_PIPELINE_V2_LABEL=pipeline-beta`, taking one sandbox issue
  To do → Done and sending one to each `Blocked` reason; then `on` for the board (clear the label variable).
- **Soak2 (2026-11-21):** three live ticks on `main` at `133d037` (~16:44–17:00 UTC); see decision log PIPE-V2-D-SOAK-006–008.
  Fixture matrix (proposed): [pipeline-v2-soak2-matrix.md](./changes/pipeline-v2-soak2-matrix.md) (**PR #2509**). Tick outcome table
  (in delivery): [pipeline-v2-soak2-findings.md](./changes/pipeline-v2-soak2-findings.md) (**PR #2511**). Round robin fix shipped **#2510**
  (not soak-covered until a later `on` window). Owner: re-tick **`pipeline-beta`** issues stuck **In analysis** after reviews landed in `dry-run`.
- **Board:** group the Pawpet board by `Stage`; make sure new issues and follow-ups are added to it (auto-add).
- **Project workflows:** turn off the built-in "Item closed" and "Pull request merged" workflows (they set Done and
  race the engine). "Auto-close issue" (Status Done closes the issue) agrees with the engine closing at Done and can stay on.

### Labels (v2)

| Label | Meaning |
|-------|---------|
| `busy` | a delivery agent is working on the issue; do not start a second run |
| `manual-only` | hand-driven; the engine and autonomous implementation never touch it |
| `needs-owner` | only on execute-plan control issues, where the runtime reads it; not an issue-pipeline state |
| `in-prod` | added by the engine when an issue reaches Done |
| `bug` / `feature` / `task` | issue form type; the Definition of Ready is checked per form |
| `AAT-progress` / `AAT-passed` / `AAT-failed` | Agent Acceptance (`/AgentAcceptance`); see [github-labels.md](./github-labels.md) |

### Agent acceptance (`/AgentAcceptance`)

Holistic acceptance on a **parent** issue. With `aat.enabled` false it stays human- or agent-invoked and does not gate In UAT. With `aat.enabled` true (the repo config since #2448 P4) and both org fields present, it is the engine's blocking gate from **In Main** to **In UAT** for issues that are not follow-ups: `aatSatisfied` for `delivery.lastMergeSha` and `uatContainsLatestMerge` are both required. Follow-ups keep intent review. The production-deploy guard stays on #2424.

1. **Eligibility:** Parent issues only — not bodies with `<!-- v2:follow-up of=#n -->`.
2. **Labels:** human-facing; `aat-start` ensures labels and sets `AAT-progress`; `aat-pass` / `aat-fail` update labels after the comment (REST via `github_issue_workflow.js`, not `gh issue edit`). The engine does not read the labels. **Token:** `GH_TOKEN` or `PAWPET_CLAUDE_TOKEN` in agent sessions. Agents never write `Stage`, `Acceptance`, or `Acceptance fail reason`.
3. **Verdict record:** last line of the verdict comment, `<!-- v2:aat verdict=pass|fail|inconclusive merge=<sha> -->`. A fail includes `reason=scope|implementation|quality`. Pass and inconclusive omit `reason`. `inconclusive` is a verdict, not a reason. A fail without a known reason is ignored. Only a listed agent's comment newer than the engine's latest `v2:aat-launch` for that merge counts.
4. **INCONCLUSIVE and timeout** share `aat.maxInconclusive` per merge, then `Blocked=stalled` while the issue stays In Main. A launch still inside `aat.timeoutMin` is not relaunched. A timeout is not a fail.
5. **Fail paths:** `quality` stays In Main until a newer linked merge into `main`. `scope` and `implementation` return to In progress and stay there until a newer linked merge into `main`. `scope` relaunches delivery once on the existing programme. `implementation` is a `bug` follow-up (`<!-- v2:follow-up of=#parent -->`, `Priority=Urgent` when that field exists) whose PRs also `Refs` the parent. Neither sets `Blocked` while a linked PR is open or, for implementation, while such a follow-up is open.
6. **Waiver:** a human `Manual` or `Skipped` is bound with `v2:aat-waive` for one merge. `Manual` is cleared when the latest merge changes. `Skipped` stays, and the new merge gets its own waive. A bound waiver is not overwritten by a pass or a newer fail.
7. **Checks:** Original intent (summary, acceptance criteria, Definition of Done) and behaviour on `main` at the merge SHA. `scope` means a stated criterion or planned phase has no merged implementation. `implementation` means the work was attempted and the behaviour on `main` is wrong. `quality` means the behaviour matches and only small fixes remain; those still block In UAT. A pass means nothing has to merge before In UAT.

Skill: [`.cursor/skills/agent-acceptance/SKILL.md`](../../.cursor/skills/agent-acceptance/SKILL.md).

### Decision log

| ID | Decision | Status |
|---|---|---|
| PIPE-AAT-D-001 | Acceptance gates **In Main → In UAT**. This supersedes #2424 owner decision 1's placement. #2424's In UAT acceptance rows are withdrawn. The production-deploy guard stays on #2424 | Accepted for this issue |
| PIPE-AAT-D-002 | Fail reasons are `scope`, `implementation`, `quality`. `inconclusive` is a verdict | Accepted |
| PIPE-AAT-D-003 | `scope` and `implementation` go to In progress and stay there until a newer merge into `main`. `quality` stays In Main. Neither sets `Blocked` while a linked PR is open or, for implementation, while an open follow-up still exists, because the engine never clears `Blocked`. A scope rewind that has not relaunched yet does not stall just because activity is already quiet | Accepted |
| PIPE-AAT-D-004 | In UAT needs `aatSatisfied` for the latest merge and `uatContainsLatestMerge` | Accepted |
| PIPE-AAT-D-005 | When `aat.enabled` and both fields exist, a non-follow-up does not get the intent-review doorbell. Follow-ups still do | Accepted; `aat.enabled` true in config as of #2448 P4 |
| PIPE-AAT-D-006 | `implementation` remediation is `bug` follow-up issues whose PRs also `Refs` the parent, with `Priority=Urgent` when that field exists. `scope` relaunches delivery. `quality` is small PRs on the parent | Accepted |
| PIPE-AAT-D-007 | `Manual` is bound to one merge and cleared on a newer merge. `Skipped` persists: a new sha gets its own skipped waive even when an older sha already has one. A bound `Manual` or `Skipped` is not overwritten by a pass write or a newer fail | Accepted |
| PIPE-AAT-D-008 | The production-deploy guard is not part of this issue | Accepted |
| PIPE-V2-D-SOAK-001 | An unclaimed body edit by a login that several pool ids share is a human edit (two distinct ids approve). Soak-1 #2480 converged on one signed review from the run that had edited | Proposed (#2385 soak, owner merge) |
| PIPE-V2-D-SOAK-002 | Pickup is least recently used **per issue**, across ticks, read from that issue's own `v2:launch` records; other issues do not count. Amends #2428 D3 (no persisted LRU): nothing new is stored. Soak-5/6 #2484/#2485 showed config order every tick starves the third agent | Superseded by PIPE-V2-D-SOAK-006 |
| PIPE-V2-D-SOAK-006 | One board-wide round robin. No launch yet → first startable agent. Every later assignment is the next startable agent, wrapping, including the next pickup on the same issue and the first pickup on the next issue. Cursor is the newest `v2:launch`; in-scope picks in the same tick advance it. Owner 2026-11-21: spread assignments; the start is wherever the ring is, then round robin | Accepted (owner, 2026-11-21) |
| PIPE-V2-D-SOAK-003 | WIP counts only In progress issues with an engine launch record. Five hand-driven issues held the cap of 2 and kept #2480 in Ready | Proposed |
| PIPE-V2-D-SOAK-004 | A `busy` doorbell holds a timed-out pickup for one extra timeout at most; the Claude workflow fails a run that left no comment or reaction | Proposed |
| PIPE-V2-D-SOAK-005 | `Blocked=paused` is never woken by a comment. Dry-run, no-identity and out-of-scope actions log `pipeline_v2_planned`, not `pipeline_v2_applied` | Proposed |
| PIPE-V2-D-SOAK-007 | **In analysis → Ready** and `busy` removal apply on a tick while `ISSUE_PIPELINE_V2=on`. Signed reviews that land after the repo returns to `dry-run`, or between ticks, do not move `Stage` until the next live tick (soak2 #2507/#2508). Agents must not open delivery PRs until **Ready** | Accepted (soak2, 2026-11-21) |
| PIPE-V2-D-SOAK-008 | Spec and review agents must not edit the issue body to evade launch safety (`detectRiskyScope` in `.github/scripts/triage-lib.js`, `preflightIssue` in `agent-safety-lib.js`): e.g. rewording **Security or Sensitive Area** to `No` while the plan still describes security/crypto escalation. Use **`Blocked=decision`** and leave the body truthful. Soak2 #2495: spec passed, then review edited the body to drop keyword tripwires | Accepted (soak2, 2026-11-21) |
| PIPE-AAT-D-009 | Inconclusive and timeout share `maxInconclusive`, then `Blocked=stalled`. Product fails are not a two-strike `Blocked=decision` cap. This supersedes #2424 owner decision 3 for the In Main gate | Accepted for this issue |

## Live workflow (legacy, until `ISSUE_PIPELINE=on`)

When `ISSUE_PIPELINE` is `on`, this section is **historical only** — use [§Planned workflows by status](#planned-workflows-by-status) and the dispatcher instead. After cutover, remove stale `human-reviewed` / `agent-approved` / `Agent1:*` labels from open issues (spec §14.4).

```
Backlog → In Analysis (+ human-reviewed) → [Auto Check] → Ready → In progress → In Main → In UAT → Done
                                    ↓
              remove human-reviewed (pause) — re-add when answered
```

1. **Backlog** — New issues enter here after filing via a form.
2. **In Analysis** — A maintainer reviews the issue: confirms clarity, priority, and that it belongs in the backlog. Move Project status to **In Analysis** and add the `human-reviewed` label.
3. **Auto Check** (process, not a status) — The [triage workflow](../.github/workflows/triage-human-reviewed.yml) runs when `human-reviewed` is applied:
   - If the issue is complete and safe → move to **Ready** and apply `agent-approved`.
   - If more information is needed → add `question`, **remove `human-reviewed`** (pauses the workflow), comment on what is missing, and move the issue to **Backlog** until resolved.
   - If the issue must not be automated → add `manual-only` and leave status **In Analysis**.
4. **Ready** — Issue is approved for implementation. The [agent dispatch workflow](../.github/workflows/agent-dispatch.yml) picks it up automatically when `agent-approved` is present and status is **Ready**.
5. **In progress** — Cursor agent dispatched (`busy` added). Stays here while the PR is open. If blocked, add `blocked` + `question`, **remove `human-reviewed`** (pauses dispatch), but keep **In progress**.
6. **In Main** — After the agent PR merges to `main` ([merge handler](../.github/workflows/issue-agent-pr-merge.yml)).
7. **In UAT** — After UAT deploy succeeds for the linked `uat-YYMMDD-PR#` tag (`deploy-uat.yml` notify job).
8. **Done** — Validation complete; close the issue.

Throughout the workflow, use `busy` to signal active work. Use `question` for visibility when more information is needed; **workflow pause is controlled by removing `human-reviewed`**.

To re-run triage after updating an issue, re-add `human-reviewed` (triage clears `question` and `blocked` automatically when checks pass).

`busy` is removed when the agent PR merges to `main`.

## Cursor agent execution layer

**Legacy dispatch** applies while `ISSUE_PIPELINE` is not `on`. With `ISSUE_PIPELINE=on`, implement and monitor run only through `issue-pipeline-dispatcher.yml` (and lane workflows for manual soak).

GitHub remains the source of truth. Cursor Cloud Agents are workers that implement `agent-approved` issues.

### Components

| File | Purpose |
|------|---------|
| [`.github/workflows/agent-dispatch.yml`](../.github/workflows/agent-dispatch.yml) | Find eligible issues and launch Cursor agents |
| [`.github/workflows/agent-monitor.yml`](../.github/workflows/agent-monitor.yml) | Poll agent runs; comment; apply `blocked` / success handoff |
| [`.github/workflows/issue-agent-pr-merge.yml`](../.github/workflows/issue-agent-pr-merge.yml) | On merged `cursor/**` PR → **In Main**, record expected UAT tag |
| [`.github/workflows/promote-uat.yml`](../.github/workflows/promote-uat.yml) | On push to `main` → create `uat-YYMMDD-PR#` tag |
| [`.github/workflows/deploy-uat.yml`](../.github/workflows/deploy-uat.yml) | UAT deploy + **Notify linked agent issue** job → **In UAT** or escalate |
| `execute-plan-scope.yml` (forbidden paths on all PRs to `main`) | Required commit status; owner review clears forbidden hits ([#1980](https://github.com/AgathaTrack/AgathaTrack/issues/1980)) |
| [`.github/scripts/agent-payload-lib.js`](../.github/scripts/agent-payload-lib.js) | Sanitized task payload + prompt |
| [`.github/scripts/agent-safety-lib.js`](../.github/scripts/agent-safety-lib.js) | Preflight + forbidden path rules |
| [`.github/scripts/launch-cursor-agent.js`](../.github/scripts/launch-cursor-agent.js) | Calls Cursor Cloud Agents API v1 |
| [`.github/scripts/monitor-cursor-agent.js`](../.github/scripts/monitor-cursor-agent.js) | Polls run status via Cursor API |
| [`.github/scripts/issue-agent-handlers.js`](../.github/scripts/issue-agent-handlers.js) | Merge + UAT status transitions |

### Eligibility

An issue is dispatched when **all** are true:

- Project status **Ready** (when project secrets configured; otherwise label-only fallback)
- Labels: `agent-approved`
- Labels **not** present: `busy`, `manual-only`, `blocked`
- Labels **required**: `human-reviewed` (workflow pause when removed)
- `question` is informational and does not block dispatch
- Passes deterministic preflight (re-checks risky scope)
- No active `<!-- cursor-agent-run: ... -->` marker with status `running`

Dispatch is **single-threaded** (`concurrency: agent-dispatch`) — one issue at a time.

Triggers:

- `agent-approved` label added (immediate, after triage)
- Manual `workflow_dispatch` (optional `issue_number`, `dry_run`)

### Sanitized task payload

Raw issue comments are **never** sent to Cursor. The dispatch script:

1. Parses issue form sections via `triage-lib.js` (`### Heading` markdown).
2. Builds a structured JSON payload (summary, objective, scope, acceptance, reproduction for bugs).
3. Renders a prompt with explicit allowed/forbidden paths and verification commands.

The agent must run `./scripts/pre-push-changed.sh` and open a PR with `Refs #<n>` on success (**not** `Fixes`/`Closes` — the issue stays open until UAT is validated).

### Agent outcomes

| Outcome | Labels | Project status | Assignee |
|---------|--------|----------------|----------|
| Dispatched | +`busy` | **In progress** | — |
| PR opened | keep `busy` | **In progress** | — |
| Blocked / failed | +`blocked`, +`question`, −`busy`, −`human-reviewed` | **In progress** | `KanopeeKa` |
| PR merged | −`busy` | **In Main** | — |
| UAT deploy OK | — | **In UAT** | — |
| UAT deploy fail | +`question`, −`human-reviewed` | unchanged | `KanopeeKa` |

To retry after a block: update the issue, then re-add `human-reviewed` (triage clears `question` / `blocked` when checks pass).

### Safety boundaries

Encoded in the sanitized prompt **and** enforced in CI:

**Forbidden paths** (agent PR safety gate fails the PR):

- `db/migrations/**`
- `server/config/security.js`
- `infra/**`
- Any path matching `/auth/`, `/billing/`, or `/secrets?/` (e.g. `server/routes/auth/`)

**Allowed for agent PRs** (with gate hygiene): `.github/workflows/**` — update `docs/pipelines/ci-cd-gates.md` and `scripts/ci/assert-*-gate.sh` in the same PR when adding or renaming blocking jobs.

**Forbidden actions** (documented in prompt):

- Push directly to `main`
- Bypass PRs
- Access or log secrets
- Modify auth, billing, or permissions code
- Weaken CI gates to pass

Triage already blocks risky issues with `manual-only` before dispatch.

### Branch and PR conventions

- Agent branches: `cursor/issue-<n>-<slug>-7a9a` (Cursor may auto-generate `cursor/...`; prompt requests this pattern)
- PRs: against `main`, body must include `Refs #<n>` (keeps the issue open; merge handler reopens if GitHub auto-closed it)

### Merge → UAT automation

When an agent PR merges to `main`:

1. **[merge handler](../.github/workflows/issue-agent-pr-merge.yml)** parses `Refs #<n>` / `Fixes #<n>` from the PR body, removes `busy`, **reopens** the issue, sets the org `Stage` field to **In Main** (the board column follows through the stage mirror), and posts the expected UAT tag (`uat-YYMMDD-PR#`).
2. **[promote-uat.yml](../.github/workflows/promote-uat.yml)** runs on the `main` push, resolves the merged PR, and creates the `uat-YYMMDD-PR#` tag on the merge commit.
3. Tag push triggers **[deploy-uat.yml](../.github/workflows/deploy-uat.yml)** automatically.

When UAT deploy finishes, the **Notify linked agent issue** job in `deploy-uat.yml` sets the org `Stage` field to **In UAT** (or adds `question` on failure). Prod notify walks the Pawpet board but **selects candidates by org `Stage` = In UAT** (not the project `Status` column), then sets `Stage` to **Done** and closes the issue.

An **execute-plan control issue** is not a UAT ticket (title starts with `execute-plan`, including `[execute-plan]`). The merge handler reopens it after an accidental `Closes` at release merge but does **not** set **In Main** or post the UAT-tracking comment; UAT notify skips it. **Light-plan** tracking issues (`light-plan:` title) are UAT-tracked like product issues: release PR `Refs #n`, session ends at Pre-UAT green without closing; merge handler sets **In Main**; UAT notify sets **In UAT**; prod notify sets **Done** and closes (ISSUE-PIPELINE-D-002).

Manual UAT rerun: **Actions → Deploy UAT (uat.agathatrack.com) → Run workflow** with `deploy_ref` = your UAT tag (e.g. `uat-260709-122`).
- UAT promotion tag: `uat-YYMMDD-PR#` (created automatically on merge to `main`)

### Required secrets

| Secret | Purpose |
|--------|---------|
| `cursor_api_key` | Cursor User API Key (**github-actions-pawpet-automation** in Cursor dashboard) |
| `GH_PROJECTS_PAT` | Project GraphQL updates (UAT deploy is tag-triggered; no `workflow_dispatch` needed) |
| `GH_PROJECT_ID` | GitHub Project v2 node ID |
| `GH_STATUS_FIELD_ID` | Status field node ID |

Optional:

| Variable / secret | Default |
|-------------------|---------|
| `CURSOR_AGENT_MODEL` | Cursor default model |
| `AGENT_ASSIGNEE` | `KanopeeKa` |

#### Cursor API key setup

This repository uses a **dedicated User API Key** (non-Enterprise plans do not expose separate service accounts):

1. Cursor dashboard → **API** → create key named `github-actions-pawpet-automation`.
2. GitHub → repo → **Settings → Secrets and variables → Actions** → repository secret `cursor_api_key`.
3. Verify repo access: `curl -H "Authorization: Bearer $KEY" https://api.cursor.com/v1/repositories`

#### Project IDs (org Project Pawpet)

```bash
GH_PROJECTS_PAT=ghp_... node .github/scripts/discover-project-ids.js --org AgathaTrack
```

Pick the **Pawpet** project from the script output (not **ATSupport**). Legacy user-owned boards used `--user <login>`.

### Stage mirror (org `Stage` field)

Board columns stay on built-in Project **Status** (humans drag cards; the pipeline and release jobs keep writing Status). Agents without Projects scope read and write the org issue field **`Stage`** instead, kept in sync by [`stage-mirror.yml`](../.github/workflows/stage-mirror.yml) and `scripts/stage_mirror.js`.

| Switch | Meaning |
|--------|---------|
| `STAGE_MIRROR` repo variable `off` | Default — workflow exits immediately |
| `dry-run` | Logs intended writes only |
| `on` | Applies writes |

Reconcile uses project **Synced stage** (hidden text field) as the last-applied value. Triggers: **10-minute** schedule, `issues: edited` on this repo (field changes), and `workflow_dispatch` (`dry_run` input). **ATSupport** (`AgathaTrackPrivate`) is poll-only.

A cleared `Stage` is restored from the board column (board wins). A card with no `Status` takes its column from a valid `Stage`; with neither, or an invalid `Stage`, the item is skipped, so one empty item never ends the run.

**Write order and failures.** Each item writes its target first (the org `Stage` field, or the board column) and the synced value **last**. If the target write fails, the synced value is unchanged and the next pass retries the same change; a failure never reverts a human edit. Each item runs on its own: a failing item is logged as `[error] <repo>#<number>` (no title), the rest of the board is still mirrored, and the run then exits non-zero so the failure is visible in Actions.

**Option check.** The mirror reads the real option list of the org `Stage` field at start-up and fails loud on a mismatch with the board columns. If the projects PAT is refused read access to org issue fields (HTTP 403), it falls back to `STAGE_ISSUE_FIELD_ID` and the static list in `stage_mirror_config.js` and logs `[warn] org Stage options not verified` on every run; other API failures (auth, wrong org, 5xx) fail the run instead of using the static list. Treat the warning as open until the option list is confirmed on the org field.

**Agents:** use the REST/GraphQL issue payload `issue_field_values` / set the org **`Stage`** field when you must move stage without Projects access. Invalid values for that board are reverted on the next mirror pass (board wins). Spec and DoD: issue #2345.

| Secret / variable | Purpose |
|-------------------|---------|
| `GH_PAWPET_SYNCED_STAGE_FIELD_ID` | Pawpet **Synced stage** text field |
| `GH_ATSUPPORT_SYNCED_STAGE_FIELD_ID` | ATSupport **Synced stage** text field |
| `STAGE_ISSUE_FIELD_ID` | Numeric org **Stage** field id (avoids `/orgs/.../issue-fields` on PAT) |
| `STAGE_ATSUPPORT_REPO` | Default `AgathaTrack/AgathaTrackPrivate` |

### Monitoring and debugging

- **Weekly dependabot batch:** Actions → **Dependabot batch dispatch** (Tuesday cron; `workflow_dispatch` with `dry_run` for payload-only). Agent URL is written to the workflow job summary. Dispatched agents receive **`/run-as-me`** in the launch prompt (owner `gh` for merge and cleanup).
- **Dispatch logs:** Actions → **Agent dispatch**
- **Run polling:** Actions → **Agent monitor** (manual `workflow_dispatch` only; scheduled polling disabled)
- **Issue comment marker:** `<!-- cursor-agent-run: {...} -->` stores `agentId`, `runId`, status
- **Cursor UI:** follow the agent URL posted in the dispatch comment
- **Dry run:** `workflow_dispatch` on **Agent dispatch** with `dry_run: true`

### UAT CD notes

Current UAT deploy (`deploy-uat.yml`) is FTP-based. When `UAT_SSH_ENABLED=true`, SSH deploy can restart the backend and run migrations (`UAT_AUTO_MIGRATE=true` for automatic `migrate.js up`). **`promote-uat.yml`** creates `uat-*` tags on merge to `main`; the **Notify linked agent issue** job sets **In UAT** when all UAT gates pass.

#### CloudLinux `node_modules` (cPanel Node.js Selector)

UAT backend dependencies are **not** shipped over FTP. CloudLinux stores packages under `~/nodevenv/...` and expects **`backend/node_modules` to be a symlink** it creates when you click **Run NPM Install** in **Setup Node.js App**.

| Do | Don't |
|----|-------|
| Deploy `package.json` + `package-lock.json` via FTP | Upload or keep a real `backend/node_modules/` folder on the server |
| Run **Run NPM Install** in cPanel after `package.json` changes | Run plain `npm install` in SSH outside the CloudLinux venv |
| Delete a stale real `backend/node_modules` once, then use cPanel npm | Assume destroying/recreating the Node app removes FTP files |

The deploy workflow strips any local `server/node_modules` before FTP and excludes `node_modules` from the upload. **FTP does not delete** an existing remote folder — a leftover real `node_modules` from an older SSH/cPanel install must be removed manually once.

**Forbidden on UAT (see `docs/pipelines/uat-backend-node-modules-runbook.md`):**

| Do not | Why |
|--------|-----|
| `npm ci` / `npm install` in `backend/` without nodevenv | Creates real `node_modules/` |
| Delete or FTP-overwrite `backend/.htaccess` | Breaks Passenger |
| Upload `node_modules/` via FTP | Breaks CloudLinux symlink |

**CI invariant (requires `UAT_SSH_ENABLED=true`):** `scripts/ci/assert-node-modules-symlink.sh` runs pre/post restart; deploy fails on exit `10` (missing), `11` (real dir), `12` (broken symlink). Manual `workflow_dispatch` deploys **fail** when SSH is disabled unless `allow_unverified_deploy=true` (emergency bypass). Push deploys warn in the Actions summary when SSH is off.

Deploy summary includes `ssh_invariant_enforced` (policy), `ssh_invariant` (execution), and `deploy_verification=verified|unverified` (derived). Emergency bypass: `allow_unverified_deploy` — see `docs/pipelines/uat-backend-node-modules-runbook.md`.

**Verify backend after deploy:**

```bash
curl -sk -w "\nHTTP %{http_code}\n" "https://uat.agathatrack.com/backend/health"
# expect: {"status":"OK"} and HTTP 200
```

**Apache SPA routing:** `flutter_app/web/.htaccess` excludes `/backend` from the Flutter `index.html` fallback so API routes reach Passenger. CI stages a non-dot copy as `htaccess.spa` because FTP deploy may omit dotfiles; the UAT SSH step renames it to `.htaccess` at the domain root. **Never delete** cPanel-generated `backend/.htaccess` (Passenger) — backend FTP excludes `**/.htaccess`.

**UAT SSH and migrations (Phase 5):** when `UAT_SSH_ENABLED=true`, the SSH deploy
bundle restarts the backend and records deploy proofs before HTTP smoke. Set
`UAT_AUTO_MIGRATE=true` to run `node scripts/migrate.js up` over SSH (mirrors prod).
FTP-only deploys still require cPanel **Run NPM Install** and manual SQL when SSH
or auto-migrate is off. **In UAT** is set only after all `deploy-uat.yml` gates pass
(`smoke`, live `@smoke` E2E, full localhost E2E, and `prod-ready`).

**Production promotion:** `deploy-prod.yml` runs automatically after green UAT
**`Prod ready`** (stub `vX.Y.Z-rc.N` tag when `PROD_DEPLOY_ENABLED` is not `true`;
full FTP + SSH deploy when `true`). Manual **`workflow_dispatch`** remains available
for overrides. See [promotion-contract.md](./promotion-contract.md).

## Deterministic triage automation

**Live** on `human-reviewed`. **Planned:** the same form checks run at the start of the To do lane, and keyword risk becomes a hint for the delivery path check ([§To do](#to-do--triage-and-intake-pawpet-claude)).

The triage workflow is implemented in:

- [`.github/workflows/triage-human-reviewed.yml`](../.github/workflows/triage-human-reviewed.yml) — GitHub Actions entry point
- [`.github/scripts/triage-lib.js`](../.github/scripts/triage-lib.js) — rules-based validation logic
- [`.github/scripts/triage-human-reviewed.js`](../.github/scripts/triage-human-reviewed.js) — applies labels, comments, and Project status updates
- [`.github/scripts/discover-project-ids.js`](../.github/scripts/discover-project-ids.js) — helper to find Project and Status field IDs

### Trigger

The workflow runs on `issues: labeled` when the label name is exactly `human-reviewed`.

The workflow also ensures these labels exist if missing: `human-reviewed`, `question`, `busy`, `manual-only`, `agent-approved`.

### Validation rules

The checker is **deterministic and policy-based** — same inputs produce the same decision. No LLM is used.

#### All issue types

- Title/summary must be present and at least 10 characters.
- Body must be long enough to be actionable.
- Placeholder or injection-like text (for example `TBD`, `fix later`, prompt-injection patterns) is rejected.
- Issues without a `bug`, `feature`, or `task` label are flagged for missing type.

#### Bug (`bug` label)

Required sections (from the issue form):

- Current Behavior
- Expected Behavior
- Steps To Reproduce
- Environment

#### Feature (`feature` label)

Required sections:

- Problem to Solve
- Proposed Solution
- Acceptance Criteria

#### Task (`task` label)

Required sections:

- Objective
- Scope
- Definition of Done

#### Risky scope (`manual-only`)

The issue is flagged for manual handling if the title or body matches sensitive keywords such as authentication, billing, payments, secrets, credentials, API keys, infrastructure, Terraform, Pulumi, migrations, `.github/workflows`, GitHub Actions, CI/CD, permissions, roles, or access control.

The **Security or Sensitive Area** form field also flags the issue when the answer is not a plain `No`.

### Outcomes

| Result | Labels | Project status | Comment |
|--------|--------|----------------|---------|
| Pass | add `agent-approved`; remove `question`, `manual-only` | **Ready** | Approval summary |
| Missing info | add `question`; remove `agent-approved` | **Backlog** | Lists missing fields; asks author to update and re-add `human-reviewed` |
| Risky scope | add `manual-only`; remove `agent-approved` | **In Analysis** | Explains sensitive scope; do not send to Cursor |

### Required secrets

Configure these in **GitHub → Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `GH_PROJECTS_PAT` | Classic PAT with `repo` and `project` (or `read:project` + `project`) scopes for Project GraphQL updates |
| `GH_PROJECT_ID` | Node ID of the GitHub Project v2 board |
| `GH_STATUS_FIELD_ID` | Node ID of the Project **Status** single-select field |

`GITHUB_TOKEN` is used for issue labels and comments only. Project field updates require `GH_PROJECTS_PAT` because `GITHUB_TOKEN` does not have sufficient Project scope.

#### Create the PAT

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)**.
2. Generate a token with at least `repo` and `project` scopes (or fine-grained equivalent with Project read/write on the organization).
3. Store it as repository secret `GH_PROJECTS_PAT`.

Use a machine/bot account PAT where possible rather than a personal developer token.

#### Find Project and Status field IDs

From a clone of this repository:

```bash
GH_PROJECTS_PAT=ghp_... node .github/scripts/discover-project-ids.js --org AgathaTrack
```

The script prints `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, and the option IDs for each status value.

**Repository ownership:** `AgathaTrack/AgathaTrack` is **org-owned**; the engineering board is org Project **Pawpet**. Use `--org AgathaTrack` when discovering project IDs.

If secrets are not configured, triage and agent workflows still update labels and comments but skip Project status changes and log a warning.

## Execute-plan v2 driver

Two workflows run execute-plan v2 without a long-lived agent session. Both are thin: they check out `main`, run
one script under `.github/scripts/`, and the logic lives in `scripts/lib/execute_plan_*.js`. Design:
`docs/agent-efficiency/plans/execute-plan-v2/work-packages-platform.md` §WP7b.

| Workflow | Events | Does |
|----------|--------|------|
| [`execute-plan-approve.yml`](../../.github/workflows/execute-plan-approve.yml) | `issue_comment` (created, edited, deleted) by the repo owner **or** `pawpet-bot` on `approve-autonomous` only | Validates `approve-autonomous` / `resume-autonomous` / `revoke-autonomous` on a control issue, creates the integration branch, status comment and labels on approve, then dispatches `execute-plan-driver.yml` for the plan (passes never run inline, so they share the driver's concurrency group). Pipeline programmes (`source_issue` on the snapshot): `pawpet-bot` may post `approve-autonomous`; `scripts/lib/execute_plan_pipeline_approve.js` enforces D-001 policy; failure → `needs-owner` on the product issue and `autonomous-revoked` on the control issue |
| [`execute-plan-driver.yml`](../../.github/workflows/execute-plan-driver.yml) | `pull_request_target` (not fork PRs; a secret-less relay job re-dispatches the driver on `main`), `workflow_run` (CI, Pre-UAT, Promote UAT, Deploy UAT), `issues` labels, 30-minute heartbeat, manual dispatch | Runs `tick` for each affected active plan and executes the one driver action it returns |

**Control comments** (one line, on the control issue, by an owner in `.github/execute-plan.config.json`):
`approve-autonomous <plan> sha256:<hash> until <ISO>`, `resume-autonomous <plan> sha256:<hash> until <ISO>`
(renews time and budgets, at most 14 days), `revoke-autonomous <plan>`. Contracts: `execute-plan-v2/contracts.md` §3.3.
An invalid approve gets one reply `approve-autonomous rejected: <reason>`; other invalid comments are ignored.
Editing or deleting an approve or resume comment stops the plan on the next pass (`approval-invalid`).

**Kill switch:** repository variable `EXECUTE_PLAN_DRIVER` — `off` (default when unset or unknown: nothing runs),
`dry-run` (validate and decide, write only the job summary), `on`. Checked first in both scripts.

**Environment and secrets**

Jobs that read automation secrets use GitHub Environment **`automation`** (deployment branches: `main` only). Repository-level copies may exist during migration; environment secrets take precedence once configured.

| Secret / variable | Location |
|-------------------|----------|
| `EXECUTE_PLAN_BOT_TOKEN`, `cursor_api_key` / `CURSOR_API_KEY`, `GH_PROJECTS_PAT`, `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, `PIPELINE_VOTE_KEY` (engine-only; signs and verifies `v2:verdict`, never passed to runners), `PAWPET_CLAUDE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (Claude doorbell workflow only) | `automation` environment |
| `E2E_BYPASS_TOKEN` | `UAT` environment |
| Deploy SSH keys and prod/UAT deploy secrets | `UAT` / `PROD` environments |
| `POSTHOG_*`, PR CI build secrets | repository (unchanged) |

**Tokens**

| Operation | Token |
|-----------|-------|
| Reads, `workflow_dispatch` (Pre-UAT, Deploy UAT), the `execute-plan-scope` commit status | `GITHUB_TOKEN` |
| Branches, sync/release PRs, `update-branch`, auto-merge, labels, comments, status comment | `EXECUTE_PLAN_BOT_TOKEN` (from `automation`) |
| Cursor API (worker launch) | `cursor_api_key` (from `automation`) |
| Plan workers | the bot token, passed by the driver at launch (`envVars`: `GH_TOKEN`, `EXECUTE_PLAN_TOKEN`); a worker `tick` refuses to run unless its token is `bot_login` |

**Identity:** invite `pawpet-bot` on every repo Cursor uses and add it to your GitHub Project. Cursor dashboard:
**`GH_TOKEN`** = bot PAT (default); **`OWNER_GH_TOKEN`** = your PAT for **`/runasme`** only (`.cursor/skills/run-as-me/SKILL.md`).
Issue/dispatch launches pass **`EXECUTE_PLAN_BOT_TOKEN`** as Cursor `envVars`. See runbooks §7.1 and
`docs/engineering/cursor-cloud-environment.md`.

Per-plan serialization comes from the single `execute-plan-driver` concurrency group plus the lease in the status
comment; the driver never waits inside a job. One action per plan per pass; the next event or heartbeat continues.

## Smoke-test log

| Date | Issue | Note |
|------|-------|------|
| 2026-07-09 | #122 | UAT delivery path smoke test — documentation-only change validating triage → Cursor agent → PR → merge to `main` → `uat-YYMMDD-PR#` tag → UAT deploy (legacy path used `release/uat-*` branches). |
