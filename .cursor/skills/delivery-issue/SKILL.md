---
name: delivery-issue
description: Engine-first delivery for one issue from Ready through finish-work and monitor until Done. Routes Method PR, light-plan, or execute-plan. Wakes mission=deliver. Spec docs/agent-efficiency/changes/delivery-issue-skill.md.
disable-model-invocation: true
---

# delivery-issue

**Outcome:** Delivery completes on `main` with DoD ticked and `finish-work` (`progress.finished` → **In Main**). The orchestrator monitors until **Done**; it does not run AAT.

**Engine contract:** Wake `mission=deliver` and `issue_number`. Never write `Stage`, `Acceptance`, or `Acceptance fail reason`. Never close the issue.

## Preconditions

- Org **`Stage`** is **Ready** (or **In progress** for `continue delivery #n`).
- Pawpet board; `ISSUE_PIPELINE_V2` on; not `manual-only`.
- Parseable **`## Delivery plan`** with **`Method:`** (`PR`, `light-plan`, `execute-plan`).
- Umbrella (sub-issues): report blockers; do not delegate on the parent (PIPE-UMB-D-001).

## Intake (label order)

1. If **`analyse-only`** is present, remove it and comment that delivery is starting (owner act, PIPE-V2-D-DELIVER-002).
2. Add **`delivery-issue`** (owner-invoked only — engine relaunches never set this).
3. `node scripts/issue_pipeline_wake.js --issue <n> --mission deliver --live`
4. Remove **`delivery-issue`** at **Done** or a human hold (not at In Main).

## Method router (read skills; do not restate)

| `Method:` | Delegate |
|-----------|----------|
| `PR` | Engine prompt + [`autonomous-pr-policy.md`](../../../docs/agent-efficiency/autonomous-pr-policy.md) §Issue-pipeline delivery PRs |
| `light-plan` | [light-plan/SKILL.md](../light-plan/SKILL.md); resume `continue light-plan #n` |
| `execute-plan` | [execute-plan/SKILL.md](../execute-plan/SKILL.md); one `tick` per turn; no `/babysit-plus` on plan PRs |

Multi-phase body with **`Method: PR`** → engine sets **`Blocked=question`** (PIPE-V2-D-DELIVER-006); skill stops.

## Babysit

Point to policy only. Before `finish-work`: every open PR the run opened must pass the babysit driver for its base (`babysit_pr_reviews.js gate` exit `0`, required CI green). **`AGENTS.md`** §Autonomy: `/delivery-issue` authorises babysit/merge for pipeline-authored or `prAuthors` PRs (PIPE-V2-D-DELIVER-005).

Driver timeout: comment next step on PR and issue; leave `busy`; `continue delivery #n`.

## Post-finish-work monitor

| Situation | Action |
|-----------|--------|
| In progress, delegate running | Keep **`delivery-issue`**; engine owns `progress.finished` |
| AAT fail `scope` | Monitor; engine `v2:aat-relaunch` once |
| AAT fail `implementation` | Monitor; parent **In progress**; run delivery on follow-up issues |
| AAT fail `quality` | Monitor; small `Refs` parent PR via its own run |
| In Main → In UAT → Done | Monitor only; remove label at **Done** |

Do not wake `acceptance` or `release` missions. Subscribe to issue comments and PR activity while waiting.

## DoD before `finish-work`

Tick delivery DoD, no open linked `Refs` PRs, merge to `main` when code required, `## Docs` on behaviour PRs, self-review on issue or release PR.

## Stop

Same human holds as analyse-issue (`decision`, `sensitive`, `paused`, `question`). Engine holds: diagnose, re-wake `deliver` after cause fixed; do not clear the hold yourself.

## Rules

- **Cursor orchestration:** `composer-2.5` for wake, poll, triage ([`pr-review-cost-efficiency.md`](../../../docs/agent-efficiency/pr-review-cost-efficiency.md)).
- Evidence on the issue.