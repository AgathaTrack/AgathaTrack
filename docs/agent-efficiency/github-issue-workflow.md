---
title: GitHub issue workflow
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [documentation, github-issues, automation]
---
# GitHub issue workflow

This document describes how issues are filed, triaged, and moved through delivery for Agatha Track.

It covers two layers:

- **Issue pipeline v2** (shipped behind `ISSUE_PIPELINE_V2`): the org issue field **`Stage`** is the engine’s authoritative state; an engine moves issues through eight stages. The Pawpet project **Status** column is separate (humans drag cards; release jobs may update **Status**). There is no automatic two-way sync between **Status** and **`Stage`** ([#2345](https://github.com/AgathaTrack/AgathaTrack/issues/2345) mirror cancelled). See [§Pipeline v2](#pipeline-v2-the-stage-machine). Plan of record: [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). The assignee-driven v1 dispatcher (`issue-pipeline-dispatcher.yml`, `ISSUE_PIPELINE`) is **removed**; history lives in [plans/issue-pipeline-automation.md](./plans/issue-pipeline-automation.md) and [plans/issue-pipeline-dispatcher-spec.md](./plans/issue-pipeline-dispatcher-spec.md).
- **Legacy label flow** (until `ISSUE_PIPELINE_V2=on`): the `human-reviewed` label triggers deterministic triage, `agent-approved` triggers Cursor dispatch. See [§Live workflow (legacy)](#live-workflow-legacy-until-issue_pipeline_v2on).

## Issue forms

Issue intake uses GitHub Issue Forms in [`.github/ISSUE_TEMPLATE/`](/.github/ISSUE_TEMPLATE/). Blank issues are disabled; contributors must choose a form.

| Form | File | Purpose |
|------|------|---------|
| Bug | `bug.yml` | Report incorrect or broken behavior with reproduction steps and environment details. |
| Feature | `feature.yml` | Request a new capability or enhancement with problem statement and acceptance criteria. |
| Task | `task.yml` | Track internal engineering or maintenance work with scope and definition of done. |

New issues from these forms receive type labels (`bug`, `feature`, or `task`) and `needs-triage`.

**Legacy issues:** Issues created before these forms were introduced are not automatically normalized. They may need manual enrichment to match the fields expected by triage and future automation.

## Planned workflows by status

When `ISSUE_PIPELINE_V2` is `on`, lane behaviour is defined in [§Pipeline v2](#pipeline-v2-the-stage-machine) and the v2 engine dispatchers — not the legacy label flow in [§Live workflow (legacy)](#live-workflow-legacy-until-issue_pipeline_v2on).

## Pipeline v2: the Stage machine

An issue moves through eight stages by agent work alone, except where a human is needed. The only state is stored on the
issue; everything else (votes, linked PRs, Definition of Done progress, run liveness, deployments) is read from GitHub on
every tick. Plan of record: [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). Code: `scripts/issue_pipeline_v2*.js`
(a pure `decide(facts, config)` plus thin readers and one action executor).

### Switches and identity

| Setting | Where | Meaning |
|---------|-------|---------|
| `ISSUE_PIPELINE_V2` | repo variable | `off` (default; the job does not run), `dry-run` (decides and logs, sends nothing), `on` (writes). When `on`, label-flow triage/dispatch/monitor workflows are disabled (same guard as the retired v1 `ISSUE_PIPELINE=on` switch). |
| `ISSUE_PIPELINE_V2_LABEL` | repo variable | Optional soak scope, e.g. `pipeline-beta`. In `on` mode only issues with this label are written to; all others are still decided and logged as dry-run. |
| `WIP_LIMIT` | repo variable | Temporary. `off` lifts the Ready queue cap (`limits.wip`) for every tick, so Ready issues launch without waiting for a free slot. Any other value, or unset, keeps the committed limit. Remove the variable to restore it. |
| `engine.logins` | `.github/pipeline-agents.json` | The account(s) the engine writes as (`pawpet-engine`, secret `ENGINE_PAT` / `GH_PROJECTS_PAT` on the v2 tick). It is never a listed agent. With no matching token the tick runs as a dry run whatever the variable says. |
| `agents`, `limits`, `launchRunners`, `aat` | `.github/pipeline-agents.json` | Pool members: each entry has a logical **`id`** (rotation, timeouts, markers), an **`actsAs`** GitHub login (assignee, `@mention`, reactions), optional **`model`**, **`runner`**, and **`methods`**. Legacy rows with **`login` only** use that login as both `id` and `actsAs`. `engine.logins` must not match any `actsAs`. Limits and `launchRunners` as before. `aat` is `enabled` (boolean; true in this repo), `timeoutMin`, and `maxInconclusive`. A bad edit fails in CI. |

The workflow [`issue-pipeline-v2.yml`](../../.github/workflows/issue-pipeline-v2.yml) runs at :11 and :41 and on manual dispatch. A manual dispatch **previews by default**: it runs as a dry run even when the repo `ISSUE_PIPELINE_V2` is `on`. The job itself is still skipped while that switch is `off`, as it is on schedule. It writes only when the `live` input is ticked and the switch is `on`. The `issue_number` input is empty for the whole board or one positive integer; any other value is refused before the board is read. The optional **`mission`** input scopes stage rows for agent-woken runs: `board` (default, full pipeline) or `analyse` (To do through convergence to **Ready** only — requires `issue_number`, never `ready.launch`). Agents wake the engine with `node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live`. Full spec: [changes/analyse-issue-skill.md](./changes/analyse-issue-skill.md). Each run logs effective mode, target, and mission (`pipeline_v2_run`) before any write (#2553 P4).
Each issue gets one action per tick, logged as a `pipeline_v2_action` line. Every tick ends with one **`pipeline_v2_tick_summary`** line (`runId`, mode, target, mission, `boardReadComplete`, decision/effect/deferral/error counts, `durationMs`). A failed issue read does not abort other issues; `readFailures` marks a partial board read (#2556 P2). GitHub **blocked by** relationships (`blockedBy` GraphQL) skip stage writes and handoffs while any blocker is open (`pipeline_v2_skip` / row `blocked-by`; #2556 P3).

**`/analyse-issue`:** Cursor skill [`.cursor/skills/analyse-issue/SKILL.md`](../../.cursor/skills/analyse-issue/SKILL.md) — engine-first spec and review until **Ready**, without delivery. Orchestrator may set **`Stage` = To do** at intake only (PIPE-V2-D-ANALYSE-003); lane agents still do not write `Stage`.

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
| **Analyse orchestrator** (`/analyse-issue`) | **To do intake only** | no | no | no | no | no |
| Humans | yes | yes | no | yes | yes | yes |

This is a rule, not a permission: agent tokens can write org issue fields. **Bootstrap:** until the engine runs in `on`
mode an agent may move `Stage` for a transition it has satisfied, citing the table row and the evidence in a comment.
From `on`, only the engine writes pipeline `Stage` transitions (To do → In analysis → Ready and delivery/release), except the analyse orchestrator at **To do intake** (PIPE-V2-D-ANALYSE-003). A human hold in `Blocked` means a human is needed; the engine clears only its own engine holds (`stalled`, `launch-failed`) when their cause is gone (§Transitions, Holds).

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
| To do | spec requested from the next tier-a agent in the round robin (`cursor-a`, `claude-a`; tier b waits for the challenge tier); the agent drafts the sections and the Definition of Ready passes (a 👍 on the request) | → In analysis |
| To do | no spec result after every agent timed out once (30 min each) | stays, `Blocked=stalled` |
| In analysis | one verified green on the current body hash from a pool identity, from a run other than the one that wrote the hash (PIPE-V2-D-REV3-003, live with REV3-012) | → Ready |
| In analysis | 6 votes (👍, 👎, agent body edits) without convergence | stays, `Blocked=no-convergence` |
| In analysis | no vote after every eligible reviewer timed out | stays, `Blocked=stalled` |
| Ready | a WIP slot is free (WIP is a slot count, not the Stage column: each issue counts once, as an In progress issue the engine launched, or as a Ready issue with a delivery launch in flight (`busy`, or started inside the ack window); hand-driven and `manual-only` work takes no slot, and an unreadable issue holds one): the engine starts a run for the agreed method | → In progress once the issue is `busy` |
| Ready | WIP at the limit | stays (Ready is the queue) |
| Ready | delivery preflight refuses with `risky scope detected` (including declared sensitive area) | stays, `Blocked=sensitive` on the next tick; no launch backoff |
| Ready | start failed after 3 retries on the backoff, or a run without `busy` after the acknowledge window counts as a failed start | stays, `Blocked=launch-failed` |
| In progress | Definition of Done ticked, no open linked PR, at least one linked PR merged into `main`, `busy` released | → In Main. Intent review is requested unless `aat.enabled` is on, both acceptance fields exist, and the issue is not a follow-up |
| In progress | the newest actionable acceptance verdict for the latest merge into `main` is `fail` with `reason=scope` or `reason=implementation` (`aat.enabled`, both fields, not a follow-up) | stays. `scope` relaunches delivery once; `implementation` waits for a follow-up whose body starts with this issue's marker, or for a linked PR. Neither sets `Blocked` while that work is still open. A newer merge into `main` ends the hold |
| In progress | `busy` gone early or 24 h without activity | one resume (relaunch), then `Blocked=stalled`; issues the engine did not launch are never resumed. A resume that fails to start does not use the one resume: it is retried on the launch backoff, then `Blocked=launch-failed`. Not taken while a scope or implementation acceptance fail still holds |
| In Main | `aat.enabled` is off, or an acceptance field is missing, or the issue is a follow-up: an agent that did not author the PRs reviews what shipped against the issue's intent (does not gate) | stays |
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

### Review: votes and the markers

**Live in In analysis:** pickup and convergence are decided by the round model (`decideRound`, PIPE-V2-D-REV3-012), the first phase of [Review process v3](./changes/pipeline-v2-review-process-v3.md). That doc still says `status: proposed`, and the phases beyond P4 and the P4 acceptance are not recorded as done (PIPE-V2-D-REV3-007, -009). The pool and launch rules from [#2428](https://github.com/AgathaTrack/AgathaTrack/issues/2428) are in the decision log as `PIPE-V2-D-2428-*`.

- **Round markers** (PIPE-V2-D-REV3-008): each doorbell start, queued deferral, failed attempt and round close is an engine comment `v2:round event=… round=… identity=… attempt=… failure=…`. The live apply writes them; the rule set above is unchanged.
- **Spec and review requests** are engine comments with a hidden marker: `v2:spec-request` and `v2:review-request hash=<hash>`
  store the assigned agent **id** and who timed out; the visible line `@mentions` the agent's **`actsAs`** login. A reassignment edits the comment in place. A review request is posted on
  entering In analysis and on each new body hash. Intent review markers store `agent=<id>` the same way.
- **Verdicts** (REV3-012): In analysis is decided by the round model (`decideRound`). A round is one review request; its
  verdict is a `<!-- v2:verdict ... -->` comment from the run, posted via `node scripts/pipeline_verdict.js`, which reads the run
  nonce from `PIPELINE_RUN_NONCE` (PIPE-V2-D-REV3-010: no key and no signature). Reactions are never votes on the In analysis
  path (shared logins cannot name the voter, and the owner's reactions do not count). A red without an edit holds its round;
  a silent holder is reassigned after `reviewTimeoutMin`, or after twice that while `busy`; a holder whose doorbell failed to
  start, or that sits outside the tier-a pool, is reassigned at once; a doorbell deferred at the runner cap is rung again. The launch record carries only
  `commit=sha256(nonce)`; the verdict, posted last, is the only place the nonce appears, and each nonce counts once
  (REV3-011). An edit claim is `<!-- v2:claim ... commit=… -->` and counts once its run's verdict reveals the matching nonce.
  A verdict counts only when
  the comment author is the id's `actsAs`, its nonce belongs to an engine launch record for that id
  and stage, it was **posted** (comment time, not the tick that reads it) within `reviewTimeoutMin` of that launch, its
  kind fits the launch stage (`spec` in To do; `review` / `edit` in In analysis), its hash is the current body hash, and
  it is the id's first verdict of that kind on that hash. An `edit` claim also needs the newest body edit to be by the
  id's `actsAs` and to be no later than the claim (`claim.created_at >= editedAt`), so a later same-login revert does not
  credit an older claim.
  A red with an edit posts its verdict on the **new** hash, which the verifier accepts only for that hash. Round derivation links that verdict to the request it answered through the assignee's confirmed edit claim: request hash in, claimed hash out, claim made after that request and before the next one. A verdict on the new hash with no such claim does not count, and neither hash alone links it (#2553 P2).
- **Delivery plan:** the method (`PR`, `light-plan` or `execute-plan`, read from the body's `Method:` line, default `PR`),
  the planned work, the `agent-paths` block and the Definition of Done are written into the body during review. After
  convergence the body is frozen except for Definition of Done ticks.
- **Doorbell run:** when the engine posts, reassigns or wakes a spec, review or intent-review request for an agent whose
  runner is in `launchRunners` (`cursor` and/or `claude`), it also starts a run with the stage's task (Cursor via the
  Agents API; Claude via `pipeline-claude-run.yml` workflow dispatch with `run-name: pipeline-claude-<nonce>`). Spec pass in To do,
  adversarial review in In analysis, intent review in In Main; the run is not a delivery (no PR) and skips the legacy
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
  the pickup timeout reassigns. **Delivery** (Ready launch, In progress resume, acceptance scope relaunch) draws only **tier-a** agents that support the issue's method (`launchableAgents` in `issue_pipeline_v2_config.js`): `cursor-a` and `claude-a` for PR and light-plan, `cursor-a` alone for execute-plan; tier-b ids never implement. Doorbell pickup is unchanged. Every pickup (spec, review, intent review, wake, and the last editor asked to revise) goes only to agents whose runner is in `launchRunners`. Spec and review pickup, the queued retry for them, and wakes in To do and In analysis also go only to tier-a agents (`reviewPoolIds`, PIPE-V2-D-REV3-004); a tier-b assignee on those is reassigned on the next tick, without waiting out the timeout, and is never rung again. Intent review, and wakes in other blocked stages, keep every startable agent. An assignee outside that set is reassigned on the next tick, without waiting out the timeout; a wake rings the holder only when that holder is startable, and does nothing when no startable agent is left. When none is left for a new request, To do and In analysis set `Blocked=stalled` and intent review is skipped. Assignment is one round robin over those startable agents, in config order. With no engine launch on the board yet, the first assignment is the first startable agent. Every later assignment — the next pickup on that issue, or the first pickup on another issue — is the next agent in the ring, wrapping. The cursor is the newest engine `v2:launch` on the board. Assignments already chosen earlier in the same tick move it, and only an in-scope decision does, so several fresh issues in one tick do not all land on the same agent. A timeout reassignment takes the next agent who is still eligible. Nothing new is stored. The full `agents` list still counts for votes and convergence.
- **Launch preflight:** a delivery launch (Ready, and the one resume) still runs the legacy safety preflight
  (`.github/scripts/agent-safety-lib.js`): the risky-scope and blocking-label (`busy`, `manual-only`, `blocked`) checks
  stand; an issue waiting on a human has `Blocked` set, which the engine never launches. Keyword risk scanning
  (`detectRiskyScope` in `.github/scripts/triage-lib.js`) scans the title and in-scope sections only — text under
  **`### Out of scope`** (or `Out-of-scope`) is excluded so exclusion lists do not trip preflight (PIPE-V2-D-PREFLIGHT-001).
  **Security or Sensitive Area: Yes** and in-scope sensitive work are still refused. Its `agent-approved` and `human-reviewed` label requirements are retired under v2, where a
  converged review and Ready are the approval, so the engine supplies those two labels to the check itself. A refusal
  records `v2:launch-failed` with the reason and counts as a failed start. When the reason is
  `preflight: risky scope detected`, the next tick sets `Blocked=sensitive` instead of backoff retries (unless label
  **`owner-approved-delivery`** is already present). The owner clears `Blocked`, adds that label, and the next tick may
  `ready.launch` again; launch preflight skips risky-scope scan when the label is present.
- **Tick log:** each tick logs `pipeline_v2_action` before applying an action and `pipeline_v2_applied` after, with what
  was done (`launch:`, `launch-failed:`, `doorbell:`, `doorbell-failed:<agent>:<reason>`, comments, writes). When the
  action was not written (dry-run mode, no engine identity, or outside the scope label) it logs `pipeline_v2_planned`
  with the same list instead, so a log line never claims a write that did not happen. **`runner-queued:`** counts as a
  **deferral** in the summary, not a confirmed effect. In analysis rounds log **`pipeline_v2_round_plan`** with the
  **`decision`** row used that tick. **Normal tick (excerpt):** `pipeline_v2_run` → per-issue `pipeline_v2_action` →
  `pipeline_v2_tick_summary` with `boardReadComplete:true`, `confirmedEffects` > 0 when live. **Recovery (excerpt):**
  one `readFailures` entry, `boardReadComplete:false`, other issues still logged; a board list failure still emits
  summary with `errors:1`. **Blocked wake:** on a blocked issue, a human reply wakes the stage agent; the `v2:wake`
  comment is written only after a confirmed doorbell, so a Claude runner cap does not consume the reply (#2556 P1).

### Delivery contract

A delivery agent, whatever the method, must:

1. set `busy` when it starts (the engine sets it at launch; the agent keeps it while it works);
2. reference the issue as `Refs #n` in **every** PR it opens, never `Closes` / `Fixes` / `Resolves` (those auto-close the
   issue on merge; an issue must stay open through UAT and prod), including the release PR of a light-plan;
3. tick the Definition of Done as items land;
4. remove `busy` when finished, or set `Blocked` with a reason when it gives up.

A PR is linked to an issue when its body says `Refs|Closes|Fixes|Resolves #n` and it appears in the issue's timeline. Only
merges into `main` count; phase PRs merged into an integration branch are open or closed work, not delivery.

**Light-plan programmes** (body `Method: light-plan`, skill: `.cursor/skills/light-plan/SKILL.md`): the delivery agent ends
at Pre-UAT green on the release merge SHA — every **Definition of Done** item ticked, then `finish-work`. It does **not** close
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
| `sensitive` | human (owner) | Ready (risky preflight) | owner clears `Blocked`, fixes the body or adds `owner-approved-delivery` and retries; or runs delivery manually |

### Operating it

- **Lifting the WIP cap:** `WIP_LIMIT=off` (see the switches table) only changes the Ready gate. In `on` mode it still
  writes only to issues matching `ISSUE_PIPELINE_V2_LABEL`, but with the cap off every matching Ready issue launches on
  the next tick. Set it back or remove it when the soak is done.
- **Dry run:** set `ISSUE_PIPELINE_V2=dry-run`, or dispatch the workflow without `live` (a manual dispatch previews by default, so an operator following these steps cannot write while scheduled ticks are live), and read the `pipeline_v2_action` lines and the
  tick summary. Check that nothing acts on hand-driven issues (label them `manual-only`).
- **Migration (once):** dispatch [`issue-pipeline-v2-migrate.yml`](/.github/workflows/issue-pipeline-v2-migrate.yml)
  as a dry run, read the `pipeline_v2_migrate` lines, then dispatch with `apply`. It gives each open board issue a `Stage`
  (from the board column, else Backlog) and a `Blocked` reason from the legacy `question` / `needs-owner` labels.
- **Soak:** `dry-run` for a day; then `on` with `ISSUE_PIPELINE_V2_LABEL=pipeline-beta`, taking one sandbox issue
  To do → Done and sending one to each `Blocked` reason; then `on` for the board (clear the label variable).
- **Soak playbook (operators and agents):**
  - **`progress.finished` (In progress → In Main)** needs a merged PR that `Refs` the issue, no open linked PRs, every **Definition of Done** item checked `[x]`, and no `busy` label. After merge, check DoD on the issue body, then `finish-work` (or let the delivery agent do both). **`finish-work` without a complete DoD** after a resume tends to set **`Blocked=stalled`** — that is expected, not an engine bug.
  - **`ready.queued`:** with default `limits.wip`, Ready issues wait for free slots. Likely explanation: **PIPE-V2-D-SOAK-003** — WIP counts engine-started **In progress** issues plus Ready issues with a delivery launch in flight (#2553 P3). A Ready issue with a pending or unacknowledged launch holds a slot until its ack window passes. For drain-only soak windows, set repo variable **`WIP_LIMIT=off`** (workflow passes it into the tick; see `applyWipOverride` in `issue_pipeline_v2_config.js`), then remove the variable when done.
  - **Live vs dry-run:** signed reviews and merges between ticks apply on the **next** `on` tick (**PIPE-V2-D-SOAK-007**).
  - **Teardown:** close sandbox issues only when no delivery PR is open and the row’s pass criteria are met or explicitly abandoned; closing early can orphan agent runs ([soak2 sign-off](./changes/pipeline-v2-soak2-findings.md) documents premature close of **#2498** / **#2501** with open PRs).
- **Soak2 (2026-11-21 – 2026-11-22):** sign-off
  [pipeline-v2-soak2-findings.md](./changes/pipeline-v2-soak2-findings.md) — **To do → Done not proven**; shipped **#2510**, **#2511**, **#2512**, **#2517**. Fixtures **#2493–#2508** closed 2026-11-22. **Soak3:** new fixtures and a new proposal under `changes/`; proposed gates are listed in the findings doc until accepted here.
- **Preflight:** in-scope sections (including **Acceptance criteria**) still participate in `detectRiskyScope` (**#2517** only excludes **`### Out of scope`**). Soak2 **#2506** showed operator body reword to launch — agents must not do that (**SOAK-008**); treat in-scope keyword trips as an **open finding** until soak3 or a scan change.
- **Board:** group the Pawpet board by `Stage`; make sure new issues and follow-ups are added to it (auto-add).
- **Project workflows:** turn off the built-in "Item closed" and "Pull request merged" workflows (they set Done and
  race the engine). "Auto-close issue" (Status Done closes the issue) agrees with the engine closing at Done and can stay on.

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

### Decision log

| ID | Decision | Status |
|---|---|---|
| PIPE-AAT-D-001 | Acceptance gates **In Main → In UAT**. This supersedes #2424 owner decision 1's placement. #2424's In UAT acceptance rows are withdrawn. The production-deploy guard stays on #2424 | Accepted for this issue |
| PIPE-AAT-D-002 | Fail reasons are `scope`, `implementation`, `quality`. `inconclusive` is a verdict | Accepted |
| PIPE-AAT-D-003 | `scope` and `implementation` go to In progress and stay there until a newer merge into `main`. `quality` stays In Main. Neither sets `Blocked` while a linked PR is open or, for implementation, while an open follow-up still exists, because the engine never clears `Blocked`. A scope rewind that has not relaunched yet does not stall just because activity is already quiet | Accepted; the rationale "the engine never clears `Blocked`" is superseded by PIPE-V2-D-HOLD-001 (the rows are unchanged) |
| PIPE-AAT-D-004 | In UAT needs `aatSatisfied` for the latest merge and `uatContainsLatestMerge` | Accepted |
| PIPE-AAT-D-005 | When `aat.enabled` and both fields exist, a non-follow-up does not get the intent-review doorbell. Follow-ups still do | Accepted; `aat.enabled` true in config as of #2448 P4 |
| PIPE-AAT-D-006 | `implementation` remediation is `bug` follow-up issues whose PRs also `Refs` the parent, with `Priority=Urgent` when that field exists. `scope` relaunches delivery. `quality` is small PRs on the parent | Accepted |
| PIPE-AAT-D-007 | `Manual` is bound to one merge and cleared on a newer merge. `Skipped` persists: a new sha gets its own skipped waive even when an older sha already has one. A bound `Manual` or `Skipped` is not overwritten by a pass write or a newer fail | Accepted |
| PIPE-AAT-D-008 | The production-deploy guard is not part of this issue | Accepted |
| PIPE-V2-D-SOAK-001 | An unclaimed body edit by a login that several pool ids share is a human edit (two distinct ids approve). Soak-1 #2480 converged on one signed review from the run that had edited | Proposed (#2385 soak, owner merge) |
| PIPE-V2-D-SOAK-002 | Pickup is least recently used **per issue**, across ticks, read from that issue's own `v2:launch` records; other issues do not count. Amends #2428 D3 (no persisted LRU): nothing new is stored. Soak-5/6 #2484/#2485 showed config order every tick starves the third agent | Superseded by PIPE-V2-D-SOAK-006 |
| PIPE-V2-D-SOAK-006 | One board-wide round robin. No launch yet → first startable agent. Every later assignment is the next startable agent, wrapping, including the next pickup on the same issue and the first pickup on the next issue. Cursor is the newest `v2:launch`; in-scope picks in the same tick advance it. Owner 2026-11-21: spread assignments; the start is wherever the ring is, then round robin | Accepted (owner, 2026-11-21) |
| PIPE-V2-D-SOAK-003 | Before #2553 P3, WIP counted only In progress issues with an engine launch record. Five hand-driven issues held the cap of 2 and kept #2480 in Ready. Implemented in #2553 P3: a Ready issue with a delivery launch in flight holds a slot too, so a launch in one tick is seen by the next (multi-tick replay in `issue_pipeline_v2_wip.test.js`); a failed read holds a slot; `manual-only` and hand-driven work stay exempt | Accepted (#2553 P3); implemented |
| PIPE-V2-D-SOAK-004 | A `busy` doorbell holds a timed-out pickup for one extra timeout at most; the Claude workflow fails a run that left no comment or reaction | Proposed |
| PIPE-V2-D-SOAK-005 | `Blocked=paused` is never woken by a comment. Dry-run, no-identity and out-of-scope actions log `pipeline_v2_planned`, not `pipeline_v2_applied` | Proposed |
| PIPE-V2-D-SOAK-007 | **In analysis → Ready** and `busy` removal apply on a tick while `ISSUE_PIPELINE_V2=on`. Signed reviews that land after the repo returns to `dry-run`, or between ticks, do not move `Stage` until the next live tick (soak2 #2507/#2508). Agents must not open delivery PRs until **Ready** | Accepted (soak2, 2026-11-21) |
| PIPE-V2-D-SOAK-008 | Spec and review agents must not edit the issue body to evade launch safety (`detectRiskyScope` in `.github/scripts/triage-lib.js`, `preflightIssue` in `agent-safety-lib.js`): e.g. rewording **Security or Sensitive Area** to `No` while the plan still describes security/crypto escalation. Use **`Blocked=decision`** and leave the body truthful. Soak2 #2495: spec passed, then review edited the body to drop keyword tripwires | Accepted (soak2, 2026-11-21) |
| PIPE-V2-D-HOLD-001 | **Engine holds are re-evaluated, not latched.** `stalled` and `launch-failed` are engine holds. Each tick the engine loads full facts for them, re-runs the stage rule as if unblocked, and clears `Blocked` itself (`v2:release by=engine`) when the rule no longer ends in an engine hold. `question`, `decision`, `no-convergence`, `sensitive` and `paused` stay human holds. Replaces "the engine never clears `Blocked`". #2554: the AAT cap is per merge but the flag was per issue, so a newer merge could not recover it | Accepted (owner, 2026-11-24) |
| PIPE-V2-D-HOLD-002 | **A human clear of an engine hold is a retry request.** The engine records `v2:release by=human`; the stage's attempt markers older than the newest release stop counting, and a release writes `Attempts=0`. Before this, clearing re-blocked on the next tick (the cap and the resume marker were still there) | Accepted (owner, 2026-11-24) |
| PIPE-V2-D-HOLD-003 | **Infrastructure failures do not use the attempt budget.** An acceptance launch, a scope relaunch or a resume that fails to start is retried on `limits.launchBackoffMin`, then `Blocked=launch-failed`. Only a started run counts toward `aat.maxInconclusive` or the one resume. #2554 was blocked by two failed starts with no agent run. Doorbell ring failures in To do and In analysis are not changed yet | Accepted (owner, 2026-11-24) |
| PIPE-V2-D-HOLD-004 | **No launchable agent is a board-level error,** reported once per run with the issue numbers, ending the run red; it is never written on an issue. Covers Ready (was `launch-failed`), In progress resume, acceptance launch and scope relaunch (were `stalled`). An empty spec or review pool still sets `stalled` | Accepted (owner, 2026-11-24) |
| PIPE-V2-D-HOLD-005 | **A blocked issue is read in full** (except `paused` and `sensitive`), so an engine hold can be re-evaluated and a wake rings the current spec or review holder instead of the next agent in the round robin | Accepted (owner, 2026-11-24) |
| PIPE-V2-D-TICK-001 | **"One action per issue per tick" is not a rule.** It describes the current runner. The planned advance loop and event wakes may take several actions for one issue in one run ([changes/pipeline-v2-holds-and-ticks.md](./changes/pipeline-v2-holds-and-ticks.md)) | Accepted (owner, 2026-11-24) |
| PIPE-V2-D-TICK-002 | **`pipeline_v2_tick_summary`** ends every tick (including invalid dispatch and board list failure) with `runId`, mode/target/mission, read completeness, counts, and duration; dry-run reports `confirmedEffects:0` (#2556 P2) | Accepted (#2556, 2026-11-25) |
| PIPE-V2-D-TICK-003 | **Blocked human wake:** post `v2:wake` only after `doorbell:` succeeds so `queued` retries without a second reply (#2556 P1) | Accepted (#2556, 2026-11-25) |
| PIPE-V2-D-BLOCKEDBY-001 | **GitHub blocked by:** open blocker issues hold the row (`blocked-by`); no writes or handoff; closed blockers clear the gate; relationship read errors → `blocked-by.read-failed` for that issue only (#2556 P3) | Accepted (#2556, 2026-11-25) |
| PIPE-V2-D-PREFLIGHT-001 | Delivery preflight keyword scan ignores bodies under **`### Out of scope`** / `Out-of-scope`; title, preamble, and all other sections still count. **Security or Sensitive Area: Yes** is unchanged. Soak2 #2507/#2499/#2498/#2508 launch-failed on exclusion-list keywords in whole-body scan | Accepted (soak2, 2026-11-21) |
| PIPE-V2-D-PREFLIGHT-002 | Ready delivery: `preflight: risky scope detected` → next tick `Blocked=sensitive` (`ready.risky-scope`); no launch backoff. With label `owner-approved-delivery`, the engine does not set `sensitive` and may `ready.launch`; preflight skips risky-scope. Owner workflow: clear `Blocked`, add the label (or fix the body); manual delivery remains valid | Accepted (owner, 2026-11-23) |
| PIPE-V2-D-DISPATCH-001 | **Retire v1 pipeline dispatcher.** Delete `issue-pipeline-dispatcher.yml`, `issue-pipeline-todo.yml`, and assignee-driven lane scripts. All stage transitions are pipeline v2 (`issue-pipeline-v2.yml`) or, until `ISSUE_PIPELINE_V2=on`, the legacy label flow. `pipeline_health` schedule staleness is not ported. `<!-- pipeline-state -->` markers and `scripts/lib/pipeline_state_trust.js` stay for execute-plan auto-approve on issues that still carry them | Accepted (2026-11-24) |
| PIPE-V2-D-ANALYSE-001 | **`mission=analyse`** scoped ticks never apply `ready.launch`; at **Ready** the row is `mission.analyse.complete` | Accepted (owner, 2026-11-25); `issue_pipeline_mission.js` |
| PIPE-V2-D-ANALYSE-002 | **`mission=analyse`** requires **`issue_number`** on dispatch | Accepted (owner, 2026-11-25) |
| PIPE-V2-D-ANALYSE-003 | **`/analyse-issue` orchestrator** may write **`Stage` = To do** at intake only (exception to engine-only `Stage`; recorded in `AGENTS.md` §GitHub issues) | Accepted (owner, 2026-11-25) |
| PIPE-V2-D-ANALYSE-004 | **Engine-first:** first engine wake precedes spec pass on a `v2:spec-request` | Accepted (owner, 2026-11-25) |
| PIPE-V2-D-ANALYSE-005 | Agent **wake** = `issue-pipeline-v2` dispatch with `mission`, `issue_number`, `live`; helper `scripts/issue_pipeline_wake.js` | Accepted (owner, 2026-11-25) |
| PIPE-V2-D-RUNNER-001 | Claude runner WIP (`limits.runnerWip.claude`, default **3** when unset): counts active `pipeline-claude-run.yml` jobs. On cap, defer with label **`queued`** and `ring-doorbell` while pickup is within `reviewTimeoutMin`; after that, normal timeout/reassign (e.g. Cursor). Real doorbell failures clear **`queued`** so `ringFailed` can reassign. Cursor runners have no repo-side cap. Owner agreed **3** concurrent Claude runs (2026-11-21). Agents remove `queued` via `clear-queued` at doorbell start or `finish-work` when done | Accepted (2026-11-21) |
| PIPE-V2-D-REV3-001 | Review process v3 (revision 3): proposal in [`changes/pipeline-v2-review-process-v3.md`](./changes/pipeline-v2-review-process-v3.md). When accepted and delivered (P1–P6), replaces In analysis adversarial pickup/convergence (#2385) and review lanes (#2428); identity-based convergence, tier-a/tier-b rounds, challenge label, watchers and event triggers per that doc. Until then, §Review (shipped) and `decideInAnalysis` behaviour remain authoritative | Proposed; P4 live (REV3-012) |
| PIPE-V2-D-REV3-002 | **Unit of independence is the run.** Every doorbell starts a new agent of a type (`cursor-a`, `claude-a`, `cursor-b`, `claude-b`). A run never comes back: the next call to the same type is a different agent, including when that type wrote the spec. Type (brand and tier) chooses who is called next and nothing else; it never decides whether a vote counts. Shared logins do not matter for independence | Accepted (owner, 2026-11-22) |
| PIPE-V2-D-REV3-003 | **One green converges.** In analysis converges on one green on the current body hash from a run other than the run that wrote that hash. Who wrote a body is taken from the open round the engine started: in tier a each login maps to one type (`cursor-a` → `pawpet-bot`, `claude-a` → `pawpet-claude`), so a body edited by that login belongs to the open round's type, and an edit by a human login is a human author. The `edit` claim is an audit record, not a precondition: the spec and review prompts do not post one today, and convergence must not wait for one. Two greens are still required when the author is a human. Live in In analysis via `decideRound` (REV3-012). Challenge attribution is settled by PIPE-V2-D-REV3-006 (round records, not logins). The two-approval rule for unknown authors (D16, PIPE-V2-D-SOAK-001) and the six-vote cap are superseded for In analysis by this rule now that P4 has shipped | Accepted (owner, 2026-11-22); live in In analysis (REV3-012) |
| PIPE-V2-D-REV3-004 | **Pre-challenge pool is tier a.** `cursor-a` and `claude-a` are the only identities that take spec and normal review rings. `cursor-b` and `claude-b` are called only in the challenge tier (v3 §7). Implemented as `reviewPoolIds` in `issue_pipeline_v2_config.js`, used by spec and review pickup, their queued retry, the timeout helper, and wakes in To do and In analysis. Intent review and wakes in other blocked stages keep every startable id. Replaces the interim P2 pooling | Accepted (owner, 2026-11-22); shipped with this change |
| PIPE-V2-D-DELIVERY-001 | **Delivery is tier-a only** (`launchableAgents`): same tier gate as REV3-004, not a separate Cursor-only list. `cursor-a` and `claude-a` implement (method-capable); `cursor-b` / `claude-b` never receive Ready launch or In progress resume. Claude delivery uses `pipeline-claude-run.yml` with `METHOD_PROMPTS` (stage `In progress`, not a doorbell task). **`engineLaunched`** counts only engine comments with `purpose=delivery` (doorbell `v2:launch` does not trigger resume). | Accepted (owner, 2026-11-23); shipped |
| PIPE-V2-D-REV3-005 | **A red holds its round until the body changes or the silence timeout fires.** A red verdict is a result, so it does not wait for the silence timeout by itself, but it does not end the round either. A red that edits the body produces a new hash; the next round reviews that new hash. A red that does not edit keeps the round open on the same hash: the rejected body is not handed to the other brand. The round ends when the reviewer edits (new hash, next round), or when the reviewer stays silent for `reviewTimeoutMin` (then the busy hold, then reassign). A bare red is not a failed attempt by itself; a silent timeout is. The deviation (red without edit) is logged | Accepted (owner, 2026-11-22); not yet in code |
| PIPE-V2-D-REV3-006 | **Authorship comes from the round record.** The author of a body hash is the run that produced it: the round's type and nonce, recorded when the round closes. A human edit has no run and no brand. Login is never used for authorship, so `cursor-a` and `cursor-b` sharing `pawpet-bot` does not matter in the challenge tier. This settles the open item in REV3-003 | Accepted (owner, 2026-11-22); implemented in the pure function, not yet fed by markers |
| PIPE-V2-D-REV3-007 | **P4 is the round function, live in In analysis (REV3-012).** `scripts/issue_pipeline_v2_rounds.js` (`decideRound`) implements the normal tier (R2 to R4), the challenge tier (C1 to C4), alternation with `fallback=true`, down state, retry on silence, red-hold, stale hashes and the budgets. Its input is derived from what the engine already keeps (`scripts/issue_pipeline_v2_round_facts.js`, `issue_pipeline_v2_round_plan.js`): the spec pass, review requests (one round each, `history` as silent attempts), nonce-based verdicts on each request hash (REV3-010, -011), and doorbell launches. The tick logs `pipeline_v2_round_plan` beside each In analysis action; the live action is that plan (REV3-012). Known limits: the derived attempt start is the request time, not each retry's launch time; `lastUsed` is the board-wide cursor (PIPE-V2-D-SOAK-006); a human edit between a red and the next request is credited to the red's run; P3 round markers are written by the live engine (REV3-008) but are not yet read by the P4 derivation. Acceptance (a dry-run over beta issues showing the expected rounds) is open | Accepted (owner, 2026-11-22); dry-run logging shipped, acceptance open |
| PIPE-V2-D-REV3-008 | **P3: round markers are written by the live engine.** Each doorbell attempt and each round close leaves a hidden `<!-- v2:round … -->` comment with a visible line: `event` (`start` with the run id for audit (never the nonce, REV3-010), `queued` when the runner cap defers it, `fail` with a failure class, `close` with a verdict), `round` (R1 spec, R2 to R4, C1 to C4), `tier`, `identity`, `brand`, `attempt`, `fallback`, `hash` and `author`. Failure classes: `timeout` (a silent attempt reassigned on timeout), `not-startable` (the holder cannot be started, so it is reassigned at once), `ring-failed` (the doorbell launch failed, marked where it happens). Markers add comments to each round, which is the cost. Nothing decides on them yet; P4 reads them once derivation moves off comments | Accepted (owner, 2026-11-22); written by the live engine |
| PIPE-V2-D-REV3-009 | **P4 first acceptance dry-run is not accepted.** The run at `3c265e5` showed a real bug and a derivation gap. The bug: a round holder outside the tier pool was waited on until the timeout; now it is reassigned at once (`reason: not-startable`), as REV3-004 requires. The gap: without `PIPELINE_VOTE_KEY` the plan cannot see verdicts, so a red-edit body is treated as human-authored. Acceptance needs a re-run with the key set (see the results file §7) | Recorded (review of the first run); re-run open |
| PIPE-V2-D-REV3-010 | **No vote key, no signature.** The run is identified by its nonce, which the run reads from `PIPELINE_RUN_NONCE` and reveals only in its verdict (REV3-011). A verdict counts when its author is the identity's login, its nonce belongs to a launch record for that identity and stage, it is posted within `reviewTimeoutMin` of that launch, its hash is the current body, and it is the identity's first verdict of that kind on that hash. `PIPELINE_VOTE_KEY`, the per-run `PIPELINE_RUN_SECRET`, and the `sig=` attribute are retired (a legacy `sig=` is accepted and ignored). Residual risk, closed by REV3-011: a public nonce could be copied by a same-login peer before the run voted | Accepted (owner, 2026-11-22); implemented |
| PIPE-V2-D-REV3-011 | **Promise, then reveal.** The engine publishes `commit=sha256(nonce)` in the launch record, never the nonce. A run's edit claim (`v2:claim`) carries the same commit. The run posts exactly one verdict, as its last action, and that verdict is the only place the nonce appears. A verdict counts when `sha256(nonce)` matches a launch commit for that identity and stage, within the launch window, by the identity's login; the first reveal of a nonce counts and any later verdict with it never does. A claim counts once its run's verdict reveals the matching nonce. Claude runs use a separate public `run_ref` for the run name, run id and status lookup; the prepare step reads the nonce from the dispatch payload and masks it before anything prints. Launch records from before this change (plain `nonce=`) still verify. Edit claims in the old `v2:verdict kind=edit` form are no longer read; an unclaimed edit is treated as a human edit | Accepted (owner, 2026-11-22); implemented |
| PIPE-V2-D-REV3-012 | **The live In analysis action is the round plan.** `decideInAnalysis` calls `decideRound` on the round records derived from comments (`issue_pipeline_v2_round_facts.js`) and translates the answer into the existing actions: `request-review` for a new round, `reassign` for a retry (with `failureClass`: `timeout`, `not-startable`, `ring-failed`), `set-stage` Ready on one verified green, `set-blocked` for `stalled` and `no-convergence`, and `ring-doorbell` for a runner-cap deferral. Silence is doubled while `busy` (soak-6). The board round-robin cursor orders the least-recently-used pick. The old vote counting (two approvals, the vote cap, edit-claim gates, reaction votes) is removed from In analysis. Planning failures are not caught: the issue errors on that tick. Known limits: attempt start is the request time; a human edit between a red and the next request is credited to the red's run | Accepted (owner, go-ahead in conversation); implemented on `main` |
| PIPE-V2-D-P1-001 | Identities carry an optional `tier` (a or b), validated by `loadConfig`. `claude-a` runs `claude-haiku-5-5` through `claude_args --model` (the official input), built from the reviewed config. Effort (`high`) is recorded in config and validated, but not yet passed to the CLI: the flag is not confirmed in the action docs. claude-b is not added until the signed-verdict path (P2) exists, because two identities on one login make Claude reactions ineligible | Proposed (P1 of [review process v3](./changes/pipeline-v2-review-process-v3.md)) |
| PIPE-V2-D-P2-001 | Shared-login Claude identities (claude-a, claude-b on `pawpet-claude`) vote only by signed verdict, like the Cursor pair. A reaction from a shared login is not a vote on either the spec path or the review path (the review path had counted it; fixed in P2). The verify step applies the same rule: a shared-login run counts as having acted only when a signed verdict names its agent id and nonce, so a sibling identity on the same login cannot stand in for it. claude-b is tier b on `claude-opus-5-5`, effort medium. Until P4 the tier is recorded but not used for the challenge. Superseded by PIPE-V2-D-REV3-004: the pre-challenge pool is tier a only, so claude-b does not take spec or review rings | Proposed (P2 of [review process v3](./changes/pipeline-v2-review-process-v3.md)) |
| PIPE-V2-D-2428-001 | Logical pool ids (#2428 D1, D13): `id` is the identity for rotation, votes and convergence; `actsAs` is the GitHub login used for assignees, mentions and attribution; `checkEngineIdentity` compares the engine token with `actsAs`. | Shipped (#2430, #2433) |
| PIPE-V2-D-2428-002 | Pickup draws only startable ids (runner in `launchRunners`). An empty startable pool stalls To do and In analysis. The editor-revise fallback never selects a non-startable editor (#2428 D2). | Shipped (#2430) |
| PIPE-V2-D-2428-003 | No LRU persisted by the engine (#2428 D3). Rotation is the board-wide cursor read from the newest `v2:launch` records. | Superseded by PIPE-V2-D-SOAK-006 |
| PIPE-V2-D-2428-004 | Intent review is non-gating, is rung for In Main (#2427), and has no verdict kind (#2428 D5, D6). | Shipped (#2427) |
| PIPE-V2-D-2428-005 | Intent independence excludes the id on the newest `purpose=delivery` launch record, not `prAuthors`. With no delivery record, any startable id may review (#2428 D7). | Shipped (#2435) |
| PIPE-V2-D-2428-006 | Launch markers add `purpose`, `stage` and `commit` after `agent=`, in that order. Old records still parse and count as delivery (#2428 D8). | Shipped (#2435) |
| PIPE-V2-D-2428-007 | A doorbell launch record is written only after `launch` returns a run id. On a live tick, a missing doorbell record or `status() === 'failed'` reassigns at once. Dry-run does not apply this (#2428 D9). | Shipped (#2435) |
| PIPE-V2-D-2428-008 | HMAC run secrets, `PIPELINE_VOTE_KEY`, `PIPELINE_RUN_SECRET` and the signed `sig=` (#2428 D4, D10). The owner approved the key design on 2026-11-18. It was replaced on 2026-11-22 by PIPE-V2-D-REV3-010 and -011, and the body is amended to match. | Superseded (2026-11-22) |
| PIPE-V2-D-2428-009 | The run nonce is masked before anything prints, and the verdict script prints it only inside its verdict. No CI scan for long hex strings (#2428 D11). | Shipped (`scripts/pipeline_claude_prepare.js`) |
| PIPE-V2-D-2428-010 | `launchFn` forwards `agent` and the launch fields into `launchIssue`, so `ring()` no longer drops the agent (#2428 D12). | Shipped (#2435) |
| PIPE-V2-D-2428-011 | An edit claim counts only when it follows the newest edit, and that edit's editor is the id's `actsAs`. A same-login revert does not credit an older claim (#2428 D16). | Shipped (#2435, #2460) |
| PIPE-V2-D-2428-012 | Config has two Cursor ids (`cursor-a`, `cursor-b`) and two Claude ids (`claude-a`, `claude-b`). Delivery is tier a only (#2428 D14). Claude WIP is 3, not the 1 first proposed (PIPE-V2-D-RUNNER-001, #2428 D15). | Shipped (#2435, #2449) |
| PIPE-AAT-D-009 | Inconclusive and timeout share `maxInconclusive`, then `Blocked=stalled`. Product fails are not a two-strike `Blocked=decision` cap. This supersedes #2424 owner decision 3 for the In Main gate | Accepted for this issue |

## Live workflow (legacy, until `ISSUE_PIPELINE_V2=on`)

When `ISSUE_PIPELINE_V2` is `on`, this section is **historical only** — use [§Pipeline v2](#pipeline-v2-the-stage-machine). After cutover, remove stale `human-reviewed` / `agent-approved` / `Agent1:*` labels from open issues where they no longer apply.

```
Backlog → In Analysis (+ human-reviewed) → [Auto Check] → Ready → In progress → In Main → In UAT → Done
                                    ↓
              remove human-reviewed (pause) — re-add when answered
```

1. **Backlog** — New issues enter here after filing via a form.
2. **In Analysis** — A maintainer reviews the issue: confirms clarity, priority, and that it belongs in the backlog. Move Project status to **In Analysis** and add the `human-reviewed` label.
3. **Auto Check** (process, not a status) — The [triage workflow](/.github/workflows/triage-human-reviewed.yml) runs when `human-reviewed` is applied:
   - If the issue is complete and safe → move to **Ready** and apply `agent-approved`.
   - If more information is needed → add `question`, **remove `human-reviewed`** (pauses the workflow), comment on what is missing, and move the issue to **Backlog** until resolved.
   - If the issue must not be automated → add `manual-only` and leave status **In Analysis**.
4. **Ready** — Issue is approved for implementation. The [agent dispatch workflow](/.github/workflows/agent-dispatch.yml) picks it up automatically when `agent-approved` is present and status is **Ready**.
5. **In progress** — Cursor agent dispatched (`busy` added). Stays here while the PR is open. If blocked, add `blocked` + `question`, **remove `human-reviewed`** (pauses dispatch), but keep **In progress**.
6. **In Main** — After the agent PR merges to `main` ([merge handler](/.github/workflows/issue-agent-pr-merge.yml)).
7. **In UAT** — After UAT deploy succeeds for the linked `uat-YYMMDD-PR#` tag (`deploy-uat.yml` notify job).
8. **Done** — Validation complete; close the issue.

Throughout the workflow, use `busy` to signal active work. Use `question` for visibility when more information is needed; **workflow pause is controlled by removing `human-reviewed`**.

To re-run triage after updating an issue, re-add `human-reviewed` (triage clears `question` and `blocked` automatically when checks pass).

`busy` is removed when the agent PR merges to `main`.

## Cursor agent execution layer

**Legacy dispatch** applies while `ISSUE_PIPELINE_V2` is not `on`. With `ISSUE_PIPELINE_V2=on`, triage, dispatch, and monitor label workflows are skipped; delivery and release run only through `issue-pipeline-v2.yml` and the handlers that respect v2 ownership.

GitHub remains the source of truth. Cursor Cloud Agents are workers that implement `agent-approved` issues.

### Components

| File | Purpose |
|------|---------|
| [`.github/workflows/agent-dispatch.yml`](/.github/workflows/agent-dispatch.yml) | Find eligible issues and launch Cursor agents |
| [`.github/workflows/agent-monitor.yml`](/.github/workflows/agent-monitor.yml) | Poll agent runs; comment; apply `blocked` / success handoff |
| [`.github/workflows/issue-agent-pr-merge.yml`](/.github/workflows/issue-agent-pr-merge.yml) | On merged `cursor/**` PR → **In Main**, record expected UAT tag |
| [`.github/workflows/promote-uat.yml`](/.github/workflows/promote-uat.yml) | On push to `main` → create `uat-YYMMDD-PR#` tag |
| [`.github/workflows/deploy-uat.yml`](/.github/workflows/deploy-uat.yml) | UAT deploy + **Notify linked agent issue** job → **In UAT** or escalate |
| `execute-plan-scope.yml` (forbidden paths on all PRs to `main`) | Required commit status; owner review clears forbidden hits ([#1980](https://github.com/AgathaTrack/AgathaTrack/issues/1980)) |
| [`.github/scripts/agent-payload-lib.js`](/.github/scripts/agent-payload-lib.js) | Sanitized task payload + prompt |
| [`.github/scripts/agent-safety-lib.js`](/.github/scripts/agent-safety-lib.js) | Preflight + forbidden path rules |
| [`.github/scripts/launch-cursor-agent.js`](/.github/scripts/launch-cursor-agent.js) | Calls Cursor Cloud Agents API v1 | <!-- pragma: allowlist secret -->
| [`.github/scripts/monitor-cursor-agent.js`](/.github/scripts/monitor-cursor-agent.js) | Polls run status via Cursor API | <!-- pragma: allowlist secret -->
| [`.github/scripts/issue-agent-handlers.js`](/.github/scripts/issue-agent-handlers.js) | Merge + UAT status transitions |

### Eligibility

An issue is dispatched when **all** are true:

- Project status **Ready** (when project secrets are configured; otherwise label-only fallback)
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

1. **[merge handler](/.github/workflows/issue-agent-pr-merge.yml)** parses `Refs #<n>` / `Fixes #<n>` from the PR body, removes `busy`, **reopens** the issue, sets the org `Stage` field to **In Main**, and posts the expected UAT tag (`uat-YYMMDD-PR#`).
2. **[promote-uat.yml](/.github/workflows/promote-uat.yml)** runs on the `main` push, resolves the merged PR, and creates the `uat-YYMMDD-PR#` tag on the merge commit.
3. Tag push triggers **[deploy-uat.yml](/.github/workflows/deploy-uat.yml)** automatically.

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
for overrides. See [promotion-contract.md](../pipelines/promotion-contract.md).

## To do — triage and intake (pawpet-claude)

Planned lane: the same deterministic form checks run at the start of **To do** before delivery dispatch; keyword risk becomes a hint for the delivery-path check.

## Deterministic triage automation

**Live** on `human-reviewed`. **Planned:** see [§To do — triage and intake (pawpet-claude)](#to-do--triage-and-intake-pawpet-claude).

The triage workflow is implemented in:

- [`.github/workflows/triage-human-reviewed.yml`](/.github/workflows/triage-human-reviewed.yml) — GitHub Actions entry point
- [`.github/scripts/triage-lib.js`](/.github/scripts/triage-lib.js) — rules-based validation logic
- [`.github/scripts/triage-human-reviewed.js`](/.github/scripts/triage-human-reviewed.js) — applies labels, comments, and Project status updates
- [`.github/scripts/discover-project-ids.js`](/.github/scripts/discover-project-ids.js) — helper to find Project and Status field IDs

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
| [`execute-plan-approve.yml`](/.github/workflows/execute-plan-approve.yml) | `issue_comment` (created, edited, deleted) by the repo owner **or** `pawpet-bot` on `approve-autonomous` only | Validates `approve-autonomous` / `resume-autonomous` / `revoke-autonomous` on a control issue, creates the integration branch, status comment and labels on approve, then dispatches `execute-plan-driver.yml` for the plan (passes never run inline, so they share the driver's concurrency group). Pipeline programmes (`source_issue` on the snapshot): `pawpet-bot` may post `approve-autonomous`; `scripts/lib/execute_plan_pipeline_approve.js` enforces D-001 policy; failure → `needs-owner` on the product issue and `autonomous-revoked` on the control issue |
| [`execute-plan-driver.yml`](/.github/workflows/execute-plan-driver.yml) | `pull_request_target` (not fork PRs; a secret-less relay job re-dispatches the driver on `main`), `workflow_run` (CI, Pre-UAT, Promote UAT, Deploy UAT), `issues` labels, 30-minute heartbeat, manual dispatch | Runs `tick` for each affected active plan and executes the one driver action it returns |

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
| `EXECUTE_PLAN_BOT_TOKEN`, `cursor_api_key` / `CURSOR_API_KEY`, `GH_PROJECTS_PAT`, `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, `PAWPET_CLAUDE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (Claude doorbell workflow only) | `automation` environment |
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
