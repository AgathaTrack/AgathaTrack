---
title: Pipeline v2 concurrency queue
owner: Agent efficiency
audience: owner
status: in-delivery
status_since: 2026-11-27
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-27
tags: [agent, pipeline, ticks, concurrency]
---

# Pipeline v2: stop losing scoped ticks to the concurrency group

Owner approved the direction on 2026-11-27 (PIPE-V2-D-QUEUE-001, Accepted). PR A moves the concurrency group to the `tick`
job with `queue: max`; PR B adds the wake-script watch. This file is folded and deleted when both are delivered.

Trigger: an `/analyse-issue` run on #2672 lost most of its `workflow_dispatch` ticks (`mission=analyse`,
`issue_number=2672`). Many runs ended `cancelled` with no jobs.

## What happens today

`issue-pipeline-v2.yml` has one **workflow-level** group and no queue option:

```yaml
concurrency:
  group: issue-pipeline-v2
  cancel-in-progress: false
```

With this setting GitHub protects the **running** run only. When a new run joins the group while one is running and one
is pending, the older pending run is cancelled. A run cancelled while pending never gets a job.

Three consequences, each checked in the repo:

1. **Scoped ticks are not interchangeable with board ticks.** HT-R-001 says collapsing loses nothing because the newest
   run reads every issue. That holds for board runs only. A board tick returns `stage-backlog` for a Backlog issue
   (`decideBacklog`, `scripts/issue_pipeline_v2_decide.js`); only `mission=analyse` moves Backlog → To do
   (`analyse.intake`). When an `issues` or `issue_comment` event displaces a pending analyse dispatch, the intake step
   is lost, not just delayed. Later stages are less exposed: board ticks do work To do and In analysis, and the
   `analyse-only` label holds an issue at Ready.
2. **Our own edits cause it.** Editing the issue, adding `analyse-only` and posting comments each start a board run in
   the same group, while the analyse dispatch is still pending.
3. **Events the gate rejects still displace.** The group is declared on the workflow, so a run joins it before the
   `wake-gate` job decides anything. Engine-authored comments and comments from untrusted authors (HT-R-002; the
   repository is public) end with `tick` skipped, but they have already pushed a pending scoped dispatch out.

## What is not verified

- Run-level evidence from the incident (run `46079254419`, "one of about 100 dispatches succeeded"). It comes from the
  analysis that prompted this proposal. Not re-pulled here.
- Resolved: `queue: max` exists and is valid at job level (GitHub changelog 2026-05-07; job-level `concurrency` syntax
  per the current docs). Up to 100 pending runs or jobs per group, FIFO by time waiting, with `cancel-in-progress` false
  or unset.
- Still unverified: whether a job **skipped** by `if:` occupies a queue slot. Not documented in the sources checked. The
  smoke test in *Delivery plan* step 4 settles it. Either way, a rejected event can only queue behind the group, not
  displace a scoped dispatch.

## Proposal

| ID | Change | Why |
|----|--------|-----|
| PIPE-V2-CQ-R-001 | Move `concurrency` from the workflow to the `tick` job, group `issue-pipeline-v2`, and add `queue: max` | Gated-out events never reach the group (consequence 3). Pending scoped dispatches queue in order instead of replacing each other (1, 2). Serialisation of every engine write is kept |
| PIPE-V2-CQ-R-002 | `scripts/issue_pipeline_wake.js` dispatches once, finds the run it started, and waits for its conclusion. It re-wakes once only when that run is `cancelled` with no jobs | Replaces a "no tight loops" prose rule in the analyse and delivery skills with behaviour that cannot loop. Also covers any displacement the queue does not prevent |
| PIPE-V2-CQ-R-003 | Amend PIPE-V2-HT-R-001: only **board** runs may be collapsed; a run with `issue_number` or `mission` must not be. Amend HT-R-002: gated-out events do not enter the group | Keeps the requirement text true after R-001 |

R-001 and R-003 ship together in one workflow PR; R-002 is a separate small PR.

### Cost

HT-R-001's collapse also limited Actions minutes. With `queue: max`, a burst of events becomes a queue of full board
runs, up to 100. Mitigations to weigh in review:

- Job-level scope means rejected events cost only the short `wake-gate` job.
- The `tick` job has `timeout-minutes: 10`, and the board read is the same work the collapsed run did once.
- If the queue shows more than a few waiting board runs in practice, add a **board-only** dedupe in `wake-gate`
  (skip a board event when another board run is already pending) rather than going back to the shared collapse.

## Alternatives considered

- **Per-issue group, `issue-pipeline-v2-<issue_number or board>`.** Rejected for now. The single group also
  serialises WIP-cap counting, the Claude runner cap and the round-robin cursor. Scoped ticks in parallel with a board
  tick can both launch. This is P5 in [pipeline-v2-holds-and-ticks.md](./pipeline-v2-holds-and-ticks.md), blocked on
  the allocator in HT-R-006.
- **Wake-script change alone (R-002).** Cheap, but it only retries after the loss, and it does not stop untrusted
  comments from cancelling a pending dispatch.
- **Doc-only rule.** The analyse skill already tells agents to be careful; the incident shows prose does not hold.

## Operational workaround (no repo change)

Until the workflow changes: batch issue edits, labels and comments **before** the wake; run one
`node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live`; do not touch the issue until that run's
`tick` job has started.

## Delivery plan and verification

1. Owner decision on PIPE-V2-D-QUEUE-001 (sensitive path).
2. PR A: workflow concurrency (R-001), HT-R-001 and HT-R-002 amendments (R-003), canonical-docs sync in
   `github-issue-workflow-wire.md` and `-behaviour.md`.
3. PR B: wake-script watch and re-wake (R-002), with unit tests beside `issue_pipeline_v2_wake.test.js`.
4. Check after PR A is on `main`: on a test issue in Backlog, dispatch `mission=analyse` and immediately post a
   comment from a trusted account and one from an untrusted account. Expect the analyse run to start, the trusted
   comment to queue behind or ahead of it, and the untrusted comment to run `wake-gate` only.
5. Fold this document into the canonical docs and delete it once PR A and PR B are delivered.
