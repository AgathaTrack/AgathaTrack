---
title: analyse-issue skill and pipeline mission scope
owner: Agent efficiency
audience: agent
status: proposed
status_since: 2026-11-25
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-25
tags: [agent, pipeline, skill, analyse-issue]
---

# analyse-issue skill and pipeline mission scope

Plan and normative spec for **`/analyse-issue <n>`**: engine-first intake, agent-woken per-issue ticks, and a
**`mission`** parameter so scoped runs do not launch delivery when the issue is **Ready**. Future skills (e.g.
deliver / e2e) extend the same mechanism.

Tracking: skill [`.cursor/skills/analyse-issue/SKILL.md`](../../../.cursor/skills/analyse-issue/SKILL.md) · pipeline v2 [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385).

## Outcome

One command takes a Pawpet board issue from intake through **spec (To do)** and **peer review (In analysis)** until org
**`Stage` = Ready** or a documented **`Blocked`** hold — without depending on the `:11/:41` cron schedule.

## Why `mission` exists

| Question | Answer |
|----------|--------|
| Why not only `issue_number`? | A single-issue tick still runs the full `decide()` table. At **Ready** the default row is **`ready.launch`** (delivery). An analyse skill must stop at Ready without starting implementation. |
| Why not let agents write `Stage` = Ready? | Convergence, round markers, and audit trail belong to the engine (`decideRound`, `set-stage` with evidence). |
| Future skills | **`mission=deliver`** (planned): only Ready → In progress → … **`mission=e2e`** / **`uat`** (planned): release lanes. Same workflow input; extend `issue_pipeline_mission.js`. |

### Mission values (shipped in this change)

| Mission | `issue_number` | Stage rows active | Stops with |
|---------|----------------|-------------------|------------|
| `board` | optional | All (default cron) | n/a |
| `analyse` | **required** | Backlog, To do, In analysis; **Ready is no-op** | `mission.analyse.complete` at Ready |

Scheduled ticks omit `PIPELINE_V2_MISSION` (treated as `board`).

### Engine contract (implemented)

- `scripts/issue_pipeline_mission.js` — `resolveMission`, `missionGuard`
- `decideStage` calls `missionGuard` before stage rows
- At **Ready** with `mission=analyse`: `{ type: 'none', row: 'mission.analyse.complete' }` — never `ready.launch`
- At **In progress** and later with `mission=analyse`: `mission.analyse.post-ready`

**Wake payload (agents):**

```bash
node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live
# or: gh workflow run issue-pipeline-v2.yml -f issue_number=<n> -f mission=analyse -f live=true
```

Log line: `pipeline_v2_run` includes `"mission":"analyse"` and `"target":<n>`.

## Terminology

| Phrase | Meaning |
|--------|---------|
| **Engine doorbell** | Engine → agent: `v2:spec-request` / `v2:review-request`, assignee, Cursor/Claude launch |
| **Wake engine** | Agent → engine: dispatch scoped tick (`issue_number` + `mission` + `live`) |

## Who writes `Stage` (policy update)

| Writer | `Stage` |
|--------|---------|
| Engine | All pipeline transitions (including To do → In analysis → Ready) |
| **Analyse orchestrator** | **Intake only:** set **To do** when starting `/analyse-issue` (org field PATCH with full value set — preserve `Blocked`, `Attempts`) |
| Lane agents (spec / review) | **No** `Stage` |
| Humans | Any |

Ready and delivery stages remain engine-only.

## Engine-first procedure (normative)

| Step | Actor | Action |
|------|-------|--------|
| 0 | Orchestrator | Confirm issue on Pawpet board; not `manual-only` unless intentional; PATCH **`Stage` = To do**; comment `analyse-issue started`. |
| 1 | Orchestrator | **Wake engine** `mission=analyse`, `live=true`, `issue_number=n`. |
| 2 | Engine | **`request-spec`** + doorbell tier-a agent (round robin). |
| 3 | Assignee | Run **spec-agent** skill: body, DoR, 👍 or signed spec up; `finish-work` if `busy`. |
| 3b | Assignee | **Wake engine** again (same mission). |
| 4 | Engine | Spec pass → **In analysis** + **`request-review`** + doorbell reviewer. |
| 5 | Reviewer | **review-agent**: verdict / edits; `finish-work`. |
| 5b | Reviewer | **Wake engine**. |
| 6 | Engine | `decideRound`: reassignment, new round, **Ready**, or **Blocked** (`no-convergence`, `stalled`, …). |
| 7 | Orchestrator | Repeat 5b–6 until **`Stage` = Ready** or hold. At Ready, tick returns **`mission.analyse.complete`** — skill **ends** (no delivery). |

**Ordering:** spec work happens **after** the first wake so a `v2:spec-request` exists (`deriveSpecFacts` requires it for `passedBy`).

## Per-issue focus

- `ISSUE_NUMBER` validated before board read ([#2553](https://github.com/AgathaTrack/AgathaTrack/pull/2553) P4).
- **`mission=analyse` refuses** dispatch without `issue_number`.
- P4 “read only that issue” from [holds-and-ticks](./pipeline-v2-holds-and-ticks.md) remains planned; today the board is still listed but only the target issue is **decided**.

## Interaction with cron and P2 event wakes

- Cron may stay a **sweeper** ([PIPE-V2-HT-R-003](./pipeline-v2-holds-and-ticks.md)).
- Analyse skill does **not** require cron; every lane agent **wake** replaces waiting for the schedule.
- When P2 ships, agent comments may auto-dispatch ticks; explicit `issue_pipeline_wake.js` remains valid.

## Future missions (spec only)

| Mission | Purpose | Requires `#` |
|---------|---------|--------------|
| `deliver` | Ready → In progress delivery only | yes |
| `acceptance` | In progress / In Main AAT rows only | yes |
| `release` | In Main → In UAT → Done handlers | yes |

Implement by extending `MISSIONS` and `missionGuard` — same workflow input.

## Lane skill additions (when skill ships)

Under `/analyse-issue`, spec-agent and review-agent **must** wake the engine after `finish-work`:

`node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live`

## Decision log (proposed)

| ID | Decision |
|----|----------|
| PIPE-V2-D-ANALYSE-001 | **`mission=analyse`** scoped ticks never call `decideReady` launch rows |
| PIPE-V2-D-ANALYSE-002 | **`mission=analyse`** requires **`issue_number`** |
| PIPE-V2-D-ANALYSE-003 | Analyse orchestrator may write **`Stage` = To do** only at intake |
| PIPE-V2-D-ANALYSE-004 | Engine-first: first wake before spec pass on a `v2:spec-request` |
| PIPE-V2-D-ANALYSE-005 | Agent **wake** = `issue-pipeline-v2` dispatch with `mission` + `issue_number` + `live` |

## Acceptance (when behaviour is exercised in soak)

1. Issue To do → agent wakes `mission=analyse` → spec request posted.
2. Spec pass → wake → In analysis → review request.
3. Convergence → Ready; wake → log `mission.analyse.complete`; no delivery launch.
4. `mission=analyse` without `issue_number` → dispatch refused before board read.

## Related

- [github-issue-workflow.md §Pipeline v2](../github-issue-workflow.md#pipeline-v2-the-stage-machine)
- [pipeline-v2-holds-and-ticks.md](./pipeline-v2-holds-and-ticks.md)
- Skills: [spec-agent](../../../.cursor/skills/spec-agent/SKILL.md), [review-agent](../../../.cursor/skills/review-agent/SKILL.md)