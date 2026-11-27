---
title: Pipeline v2 holds and ticks
owner: Agent efficiency
audience: owner
status: in-delivery
status_since: 2026-11-24
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-24
tags: [agent, pipeline, blocked, ticks]
---

# Pipeline v2: holds and ticks

Plan of record for making `Blocked` mean "a human must act" and for moving the engine off "one action per issue per
cron tick". Owner decisions 2026-11-24: PIPE-V2-D-HOLD-001 to 005 and PIPE-V2-D-TICK-001 in
[github-issue-workflow-wire.md §Decision log](../github-issue-workflow-wire.md#decision-log). Trigger: #2554, blocked by two
failed acceptance starts with no agent run, and not recoverable by a newer merge.

## Findings this plan answers

- **Latch.** An engine hold was set for the engine's own retry state, then the issue was read for comments only, so a
  newer merge, a late vote, a merged PR or a returning agent was never seen.
- **Clearing re-blocked.** The counters lived in comment markers, not in the flag: at the acceptance cap, and after the
  one resume, a human clear stalled again on the next tick.
- **Infrastructure in the budget.** A failed acceptance start counted as a concluded attempt; no launchable agent was
  written on every issue it met.
- **Wake.** A wake after a human reply always used the round robin; the holder branch never applied, because spec and
  review facts were not loaded for a blocked issue.
- **Ticks.** In the 30 runs before 2026-11-24 19:02 UTC, 5 were scheduled (hours apart, against `11,41 * * * *`) and
  25 were manual. To do → Done needs about ten actions, so about ten ticks. A run for one issue (`issue_number`) still
  fetches every board issue before it filters. A board-wide run takes 40 s to 2 min; the repository is public.

## Phases

| Phase | Outcome | Status |
|-------|---------|--------|
| P1 | Hold semantics: engine holds re-evaluated and released by the engine; human clear is a retry; failed starts use the launch backoff; no launchable agent is a board-level error; blocked issues read in full | In delivery (this branch) |
| P2 | Event wakes: issue edited, labelled, closed or reopened, and new comment; PR closed; UAT and production deploy finished; Claude runner finished. Each dispatches a **board-wide** run in the existing `issue-pipeline-v2` concurrency group. Cron becomes the sweeper | Delivered (#2560 P3) |
| P3 | Advance loop: one run repeats decide → apply → re-read for an issue until the answer is a wait or an agent was started (cap about 5 steps) | Planned |
| P4 | True per-issue run: with `issue_number`, read only that issue, its comments and linked PRs | Planned |
| P5 | Per-issue concurrency (`issue-pipeline-v2-<number>`) and one serial allocator for the WIP cap, the Claude runner cap and the round-robin cursor | Planned, only if board-wide runs become the bottleneck |

## Requirements (planned)

| ID | Requirement | Phase |
|----|-------------|-------|
| PIPE-V2-HT-R-001 | A board-wide run is started by each event in P2's list. Board-wide runs share the one concurrency group, and pending runs are kept, not collapsed: the `tick` job uses `queue: max` (PIPE-V2-D-QUEUE-001). Scoped runs (`mission` set) must never be cancelled while pending, because a board tick does not do Backlog intake (`decideBacklog`) | P2 |
| PIPE-V2-HT-R-002 | The event job is skipped at job level when `ISSUE_PIPELINE_V2` is off, when the actor is the engine identity (its PAT-authored writes do trigger workflows), and for comments whose `author_association` is not OWNER, MEMBER or COLLABORATOR and whose author is not a listed agent login. The repository is public: anyone can comment. The concurrency group sits on the `tick` job, so an event that fails this gate never joins it (PIPE-V2-D-QUEUE-001) | P2 |
| PIPE-V2-HT-R-003 | The schedule only sweeps: it catches missed events and expired waits. Normal progress does not depend on it | P2 |
| PIPE-V2-HT-R-004 | The advance loop feeds applied writes forward into the facts, or re-reads through issue REST only. It stops before any step whose next decision depends on search results (implementation follow-ups) or on a marker it just posted and has not read back | P3 |
| PIPE-V2-HT-R-005 | A run for one issue reads only that issue unless it may launch; a launch still needs the board-wide WIP count and round-robin cursor | P4 |
| PIPE-V2-HT-R-006 | With per-issue runs, only the allocator launches delivery or doorbells; an issue run marks the issue `queued` | P5 |

## Hold gaps left after P1

- **Doorbell ring failures** in To do and In analysis still count as that agent's attempt, and an empty spec or review
  pool still sets `stalled`. Fold into P3, or a small follow-up PR, using the same launch backoff.
- **Holds set before P1** carry no `v2:hold` marker, so a human clear of one is not recognised as a retry (it re-blocks
  once, this time with the marker). The engine still releases them when the cause changes.
- **To check in P2:** whether a change to an org issue field (`Stage`, `Blocked`) fires an `issues` event. If it does
  not, the sweeper covers it.

## Recovering #2554

No manual step once P1 is on `main`. Its two `failed=1` acceptance launches are no longer attempts, so re-running the In
Main rule gives `aat.relaunch` (two failed starts, the backoff of 30 min long past). The engine releases the hold
(`v2:release by=engine`) and retries acceptance on the next tick; three more failed starts would set
`Blocked=launch-failed`.
