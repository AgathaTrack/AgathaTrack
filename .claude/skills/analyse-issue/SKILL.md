---
name: analyse-issue
description: Run pipeline v2 analysis for one issue — the engine moves Backlog to To do, posts the spec request, and runs peer review in In analysis until Ready, without launching delivery. Use as /analyse-issue <issue #>. Wakes the engine with mission=analyse and issue_number. Spec in docs/agent-efficiency/github-issue-workflow-operations.md §Analyse mission.
disable-model-invocation: true
---

# analyse-issue

**Outcome:** Org **`Stage` = Ready** (or a documented **`Blocked`** hold). **Does not** implement (no `ready.launch`).

**Engine contract:** Every wake uses **`mission=analyse`** and **`issue_number`** so the engine never starts delivery at Ready. The engine does all `Stage` writes; this skill writes none. See `scripts/issue_pipeline_mission.js` and `github-issue-workflow-operations.md` §Analyse mission.

## Preconditions

- Issue on org project **Pawpet**
- `ISSUE_PIPELINE_V2` is `on`. In `dry-run` the wake only previews, so nothing moves.
- Respect `ISSUE_PIPELINE_V2_LABEL` if set (e.g. `pipeline-beta`)
- Not `manual-only` unless the owner intends hand-driven work

## Wake engine (agent → engine)

```bash
node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live
```

Preview without writes: omit `--live` (workflow default). Unknown flags are refused.

## Engine-first procedure

1. **Start** — Read the issue and its comments. Post one comment: analyse-issue started, with the evidence link. Then **wake engine**. On a Backlog issue the engine moves it to **To do** (`analyse.intake`). An issue already in To do skips that: its first wake posts the spec request.
2. **Second wake** — Wake again. The engine posts **`v2:spec-request`** and doorbells a tier-a agent. Wake until that comment exists; the runner takes one action per issue per tick.
3. **Spec leg** — If this run is the assignee (spec requested comment / assignee), follow `.cursor/skills/spec-agent/SKILL.md`. On completion: `finish-work` if `busy`, then **wake engine** again.
4. **Review loop** — While `Stage` is **In analysis**, when this run holds the review request, follow `.cursor/skills/review-agent/SKILL.md`. After each leg: `finish-work`, **wake engine**.
5. **Orchestrator wait** — When another agent is doorbelled, poll issue `Stage` / `Blocked` and comments, or use subscriptions; re-wake only after stuck timeout if policy allows.
6. **Done** — Exit when `Stage` is **Ready** (next wake logs `mission.analyse.complete`) or stop on `Blocked` with reason on the issue.

**Never** set `Stage` yourself, at any step. The engine does intake, In analysis and Ready.

## Stop conditions

| `Blocked` / state | Action |
|-------------------|--------|
| `question` | Wait for human reply; human comment may wake stage agent on next engine tick |
| `decision`, `sensitive`, `paused` | Report owner; do not override |
| `no-convergence`, `stalled` | Report owner; optional human clear + restart from To do |
| `Ready` | Success — stop; delivery is a different skill (`mission=deliver`, planned) |

## Rules

- **Cursor orchestration:** use **`composer-2.5`** for wake, poll, and triage (see `pr-review-cost-efficiency.md`); lane work follows spec-agent / review-agent.
- Evidence on the issue, not only in chat.
- Refs pipeline v2 [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385).

## Related missions (future)

| Skill (planned) | `mission` |
|-----------------|-----------|
| Deliver / implement | `deliver` |
| E2E / UAT promotion | `release` or `uat` |

Same `issue-pipeline-v2.yml` inputs; see `github-issue-workflow-operations.md` §Analyse mission.
