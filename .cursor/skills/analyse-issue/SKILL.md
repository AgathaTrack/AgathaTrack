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

## Stage writes (policy)

With `ISSUE_PIPELINE_V2=on`, the engine makes every `Stage` transition, including the analyse intake (Backlog → To do under `mission=analyse`; **PIPE-V2-D-ANALYSE-003**, revised 2026-11-26). This skill writes no `Stage`. Adding the `analyse-only` label is not a `Stage` write.

## Engine-first procedure

1. **Start** — Read the issue and its comments. Add the label **`analyse-only`** (keep the other labels; for example `gh issue edit <n> --add-label analyse-only`; create the label once with `gh label create analyse-only --force` if the repository does not have it yet). It must be on the issue before the first wake, because any board tick can reach Ready. Post one comment: analyse-issue started, with the evidence link.
2. **Wake** — Run the wake command above. On a Backlog issue the engine moves it to **To do** (`analyse.intake`). An issue already in To do skips that step, and its first wake posts the spec request.
3. **Wake until the spec request exists** — Wake again. The engine posts **`v2:spec-request`** and doorbells a tier-a agent. The runner takes one action per issue per tick, so keep waking until that comment exists.
4. **Spec leg** — If this run is the assignee (spec requested comment / assignee), follow [spec-agent](../spec-agent/SKILL.md). On completion: `finish-work` if `busy`, then **wake engine** again.
5. **Review loop** — While `Stage` is **In analysis**, when this run holds the review request, follow [review-agent](../review-agent/SKILL.md). After each leg: `finish-work`, **wake engine**.
6. **Orchestrator wait** — When another agent is doorbelled, poll issue `Stage` / `Blocked` and comments, or use subscriptions; re-wake only after stuck timeout if policy allows.
7. **Done** — Exit when `Stage` is **Ready** (next wake logs `mission.analyse.complete`) or stop on `Blocked` with reason on the issue.

**Never** set `Stage` yourself, at any step. The engine does intake, In analysis and Ready.

## Ready boundary

The `analyse-only` label is what stops the issue at Ready (PIPE-V2-D-ANALYSE-004). The mission flag only scopes the tick it is dispatched with, and board ticks woken by label or comment events carry no mission. Do not remove the label; removing it is the owner's decision to let the general pipeline launch delivery.

## Stop conditions

| `Blocked` / state | Action |
|-------------------|--------|
| `question` | Wait for human reply; human comment may wake stage agent on next engine tick |
| `decision`, `sensitive`, `paused` | Report owner; do not override |
| `no-convergence`, `stalled` | Report owner; optional human clear + restart from To do |
| `Ready` | Success — stop; delivery is [`delivery-issue`](../delivery-issue/SKILL.md) (`mission=deliver`) |

## Rules

- **Cursor orchestration:** use **`composer-2.5`** for wake, poll, and triage (see `pr-review-cost-efficiency.md`); lane work follows spec-agent / review-agent.
- Evidence on the issue, not only in chat.
- Refs pipeline v2 [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385).

## Related missions

| Skill | `mission` |
|-------|-----------|
| Deliver / implement | `deliver` — see [delivery-issue](../delivery-issue/SKILL.md) and `github-issue-workflow-operations.md` §Deliver mission |

Same `issue-pipeline-v2.yml` inputs.
