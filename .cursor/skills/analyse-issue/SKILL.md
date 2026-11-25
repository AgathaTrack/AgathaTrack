---
name: analyse-issue
description: Run pipeline v2 analysis for one issue — engine-first To do spec, peer review in In analysis, stop at Ready without launching delivery. Use as /analyse-issue <issue #>. Wakes the engine with mission=analyse and issue_number. Plan docs/agent-efficiency/changes/analyse-issue-skill.md.
disable-model-invocation: true
---

# analyse-issue

**Outcome:** Org **`Stage` = Ready** (or a documented **`Blocked`** hold). **Does not** implement (no `ready.launch`).

**Engine contract:** Every wake uses **`mission=analyse`** and **`issue_number`** so the engine never starts delivery at Ready. See `scripts/issue_pipeline_mission.js`.

## Preconditions

- Issue on org project **Pawpet**
- `ISSUE_PIPELINE_V2` is `on` (or dry-run for rehearsal)
- Respect `ISSUE_PIPELINE_V2_LABEL` if set (e.g. `pipeline-beta`)
- Not `manual-only` unless the owner intends hand-driven work

## Wake engine (agent → engine)

```bash
node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live
```

Preview without writes: omit `--live` (workflow default).

## Stage writes (policy)

With `ISSUE_PIPELINE_V2=on`, only the engine and humans normally write `Stage` (`AGENTS.md` §GitHub issues). **This skill's orchestrator** is the sole agent exception: **one PATCH to `Stage` = To do** at intake (**PIPE-V2-D-ANALYSE-003**, owner 2026-11-25). Do not write In analysis or Ready.

## Engine-first procedure

1. **Intake** — Read issue and comments. PATCH org **`Stage` = To do** (preserve existing `Blocked` and `Attempts` in the same issue-fields payload). Post one comment: analyse-issue started with evidence link.
2. **First wake** — Run wake command above. Engine posts **`v2:spec-request`** and doorbells a tier-a agent.
3. **Spec leg** — If this run is the assignee (spec requested comment / assignee), follow [spec-agent](../spec-agent/SKILL.md). On completion: `finish-work` if `busy`, then **wake engine** again.
4. **Review loop** — While `Stage` is **In analysis**, when this run holds the review request, follow [review-agent](../review-agent/SKILL.md). After each leg: `finish-work`, **wake engine**.
5. **Orchestrator wait** — When another agent is doorbelled, poll issue `Stage` / `Blocked` and comments, or use subscriptions; re-wake only after stuck timeout if policy allows.
6. **Done** — Exit when `Stage` is **Ready** (next wake logs `mission.analyse.complete`) or stop on `Blocked` with reason on the issue.

**Never** set `Stage` to In analysis or Ready yourself — the engine does on spec pass and convergence.

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

Same `issue-pipeline-v2.yml` inputs; see change doc for the mission table.