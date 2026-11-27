---
title: delivery-issue skill — reviewed spec and implementation plan
owner: Agent efficiency
audience: agent
status: in-delivery
status_since: 2026-11-26
plan: delivery-issue-v1
last_updated: 2026-11-26
folds_into: docs/domains/cross-domain/features/program-contract.md
tags: [agent, pipeline, skill, delivery-issue]
---

# delivery-issue skill — reviewed spec and implementation plan

> **In delivery.** Steps 1–5 shipped in PR #2662 (babysit-gap Phase 1, `mission=deliver`, skills, decision rows). Step 6 soaks are best-effort per owner D6.

## 1. Outcome of this doc

Turn the draft `delivery-issue` design into a spec that matches the engine as it is on `main` (2026-11-26), and
list what must be built, in what order, and which owner decisions block each step.

## 2. Verification of the draft against `main`

| # | Draft claim | Result | Evidence |
|---|---|---|---|
| V1 | Only `analyse` is implemented; `deliver`, `acceptance`, `release` are planned | **True** | `MISSIONS` in `scripts/issue_pipeline_mission.js` has `board` and `analyse` only |
| V2 | `Method:` is parsed from the body; values `PR`, `light-plan`, `execute-plan`; default `PR` | **True** | `METHODS` and `deliveryMethod()` in `scripts/issue_pipeline_v2_launch.js` |
| V3 | `METHOD_PROMPTS.PR` is empty | **True** | `scripts/issue_pipeline_v2_launch.js` (`PR: ''`) |
| V4 | Delivery contract has four obligations and none covers babysitting | **True** | `github-issue-workflow-behaviour.md` §Delivery contract, items 1–4 |
| V5 | Babysit skills cannot be loaded by a model | **True** (flag verified, runtime behaviour not) | `disable-model-invocation: true` in `.cursor/skills/babysit*/SKILL.md` and `.claude/skills/babysit*/SKILL.md` |
| V6 | babysit-gap Phase 1 is a hard dependency | **True, but not landed** | `docs/agent-efficiency/plans/issue-pipeline-babysit-gap.md` has `status: proposed` |
| V7 | `--mission deliver` can be dispatched today | **False** | `scripts/issue_pipeline_wake.js` calls `resolveMission`, which rejects anything outside `board, analyse` |
| V8 | AAT **fail `implementation`** at In Main → parent stays In Main until the next merge | **False** | `github-issue-workflow-behaviour.md` §Transitions item 5: `scope` **and** `implementation` return the issue to **In progress**. Only `quality` stays In Main |
| V9 | AAT **pass** at In Main needs a `mission=release` wake | **Not needed** | §Transitions: In Main → In UAT is engine-owned once `uatContainsLatestMerge` holds. An agent wake adds nothing |
| V10 | AAT **fail `scope`** needs the orchestrator to re-enter delivery | **Partly** | §Holds: the engine relaunches delivery once itself (`v2:aat-relaunch` in In progress). The orchestrator should monitor, not wake |
| V11 | Implementation follow-ups are tracked by the orchestrator | **Partly** | AAT Phase 7 (`.cursor/skills/agent-acceptance/SKILL.md`): the **AAT agent** files bug issues with `<!-- v2:follow-up of=#parent -->`. They are ordinary issues with their own delivery |
| V12 | `analyse-only` removal is the owner's decision to let delivery launch | **True** | `PIPE-V2-D-ANALYSE-004` in `github-issue-workflow-wire.md` |
| V13 | Orchestrator model is `composer-2.5` | **False for Claude Code** | `CLAUDE.md` §Claude Code mechanics lists `composer-2.5` under "Not applicable" |
| V14 | Orchestrator waits with `cursor-subscriptions` and `subscribe_timer` | **Cursor-only** | Claude Code waits with a background watch, PR-activity subscription, or `ScheduleWakeup` (`CLAUDE.md` §Waiting on CI or review). `ScheduleWakeup` idle delays are ≥1200 s |
| V15 | `:11/:41` timer policy | **Not located** | Not found in the files read for this doc. Do not rely on it until cited |
| V16 | `PIPE-V2-D-DELIVER-*` decision rows exist | **False** | Proposed in §7 of this doc only |
| V17 | Multi-phase body with `Method: PR` fails closed | **Not implemented** | `deliveryMethod()` has no such check. It is a new engine rule |
| V18 | `pipeline-claude-run.yml` has a 45-minute timeout | **Not re-checked** | Cited from babysit-gap. Confirm against the workflow file before relying on it |

**Summary.** The draft's core shape (engine-first orchestrator, `Method:` routing, no `Stage` writes) is sound. Its
gate map has one wrong transition (V8), two unnecessary wakes (V9, V10), and several Cursor-only mechanics (V13, V14).

## 3. Corrections to the draft

1. **Drop the `acceptance` and `release` missions.** The engine already launches AAT (`launch-aat`) and moves
   In Main → In UAT → Done on deploy facts. An agent wake in those stages duplicates engine work. The only remaining
   agent-owned work after `finish-work` is monitoring and clearing human holds.
2. **Keep one mission: `deliver`,** scoped to **Ready** and **In progress**. Its guards are in §4.3.
3. **Fix the AAT fail table** (§4.6): `implementation` returns to In progress; the AAT agent files the follow-up issues.
4. **Remove agent-side relaunch for AAT `scope`.** The engine relaunches once (V10). The orchestrator waits.
5. **Replace Cursor mechanics** with Claude Code ones (V14) and remove `composer-2.5` (V13).
6. **Require the label order** for `analyse-only`: remove it **before** the `deliver` wake, or the Ready row will skip
   the launch (§4.3). The draft did not say this.
7. **Name the merge authority.** `AGENTS.md` §Autonomy allows a merge when the user asked the agent to babysit that PR. The draft
   does not say whether `/delivery-issue` invocation counts. Decision D3 (§7).

## 4. Structured spec (corrected)

### 4.1 Outcome

`/delivery-issue <n>` (owner-invoked only, `disable-model-invocation: true`) drives one issue from **Ready** to the
point where the engine's post-delivery rows own the rest:

- **Success:** `progress.finished` fires (Definition of Done ticked, no open `Refs` PR, a merge into `main`, `busy` released),
  the issue reaches **In Main**, and the orchestrator leaves the AAT and UAT gates to the engine.
- **Handed off:** an open PR still needs a babysit driver after the run's timeout (babysit-gap §Driver lifetime). The
  orchestrator comments the next step and leaves `busy` set. A later `continue delivery #n` resumes.
- **Blocked:** a human hold (§4.8) with evidence on the issue.

Two success levels, so the skill does not promise more than the engine delivers:

- **Orchestrator success:** In Main reached, plus a handoff comment stating what the engine owns next. The owner's run ends here.
- **User success:** Done (issue closed by the engine on prod deploy). The orchestrator keeps monitoring the issue after
  In Main to handle a `continue delivery #n`, a driver timeout or a stall. It does not wake `release`, because none exists (§3 item 1).

The orchestrator never writes `Stage`, `Acceptance`, or `Acceptance fail reason`, never closes the issue, and never runs
AAT in the session that shipped.

### 4.2 Engine contract

One new mission: **`deliver`**, `requiresIssue: true`.

| Mission | Allowed stages | Stage rows that run | Otherwise |
|---|---|---|---|
| `deliver` (new) | Ready, In progress | `ready.launch` at Ready; the In progress rows (resume, finished, stalled) | `mission.deliver.out-of-scope` |
| `deliver` at Backlog, To do, In analysis | — | none | `mission.deliver.premature` |
| `deliver` at In Main, In UAT, Done | — | none | `mission.deliver.out-of-scope` |

`missionGuard` currently returns `null` for any mission other than `analyse` (line 46 of `issue_pipeline_mission.js`).
Without a `deliver` branch, a `deliver` wake would act on every stage. The guard must be added in the same PR as the
`MISSIONS` entry.

### 4.3 Intake and guards

Intake checklist (orchestrator, before the first wake):

- Org `Stage` is **Ready** (or **In progress** for `continue delivery`).
- Not `manual-only`.
- `## Delivery plan` has a parseable `Method:` (`deliveryMethod()`); a missing line means `PR`, as the engine already does.
- DoD present; no open human hold (`decision`, `sensitive`, `paused`, `question`) without a stop-table entry (§4.8).
- Umbrella issues (sub-issues on GitHub, PIPE-UMB-D-001): the orchestrator reports sub-issue blockers and does not
  run a delivery delegate on the parent. Decision D5.

Label order, enforced by the skill:

1. If `analyse-only` is set, remove it **as the owner's act**, recorded in the issue comment (PIPE-V2-D-ANALYSE-004).
2. Add `delivery-issue` (new label, §7 D2). It is set **only** when the owner invokes `/delivery-issue`, and marks an owner-invoked
   orchestrator holding the issue. Engine-launched runs, including the one-time `aat-relaunch` for an AAT `scope` fail, do
   not set it, and the orchestrator does not act on them. The label does not mean "a delivery agent is running"; `busy` does that.
3. Wake: `node scripts/issue_pipeline_wake.js --issue <n> --mission deliver --live`.
4. Remove `delivery-issue` when the issue reaches Done, or when the orchestrator stops at a human hold (§4.8). It stays through
   In Main and In UAT, because the orchestrator monitors until Done.

Wake order matters. A `deliver` wake before step 1 is a no-op at Ready, because the `analyse-only` check runs on every tick.

### 4.4 Method router

The orchestrator reads `Method:` and does not choose a method by heuristic. Each method is a pointer to an existing skill.

| `Method:` | Delegate (read and follow, do not restate) | Orchestrator adds |
|---|---|---|
| `PR` | The engine prompt (`METHOD_PROMPTS.PR`, babysit-gap Phase 1c) | Babysit driver per the base-branch table in `autonomous-pr-policy.md` §Issue-pipeline delivery PRs |
| `light-plan` | `.cursor/skills/light-plan/SKILL.md` | Resume only via `continue light-plan #n`. Does not re-encode the phase loop |
| `execute-plan` | `.cursor/skills/execute-plan/SKILL.md` | Resolve `plan_id` from the body or control issue. One `tick` per turn. Does **not** call `/babysit-plus` on plan PRs (the execute-plan skill forbids it) |

Fail closed: a body that describes several phases or sequential PRs but says `Method: PR` gets one
`Blocked=question` comment and no delegate (V17 — needs an engine rule, decision D4).

### 4.5 Babysit obligation

The skill does not restate babysit rules. It points to:

- `autonomous-pr-policy.md` §Issue-pipeline delivery PRs (the base-branch table; babysit-gap Phase 1a),
- `issue-pipeline-babysit-gap.md` R1–R7,
- `github-issue-workflow-behaviour.md` §Delivery contract, obligations 4–5 (babysit-gap Phase 1b).

Hard gate before `finish-work`: `babysit_pr_reviews.js gate` exits `0` and the required CI is green for every open
PR the delivery opened. A run never ends with an unresolved thread and no `Blocked` reason (babysit-gap acceptance criterion 2).

Until babysit-gap Phase 1 lands, the skill **must not** ship. Without it, the orchestrator repeats a rule the engine
prompt does not enforce.

### 4.6 Post-delivery monitor (corrected gate map)

| Stage / condition | Orchestrator action | Engine |
|---|---|---|
| Ready | Wake `mission=deliver` (after label step 1) | `ready.launch` |
| In progress, busy held | Run the method delegate. Keep `delivery-issue` set | `progress.finished` when facts hold |
| In progress, `busy` gone early or 24 h quiet | Nothing. Engine resume once | One `v2:resume`, then `Blocked=stalled` |
| In progress, AAT fail `scope` | Monitor. Do not wake | Engine `v2:aat-relaunch` once on the existing programme (V10) |
| **In progress, AAT fail `implementation`** (corrected, V8) | Monitor. Do not wake. Run `/delivery-issue` on each follow-up issue the AAT agent filed, as its own run. Its PRs use `Refs <parent>` | Parent returns to In progress and stays until a newer linked merge into `main` |
| In Main, AAT fail `quality` | Monitor. Small `Refs <parent>` PR is delivered by its own run | Parent stays In Main until a newer merge SHA; AAT re-runs |
| In Main, AAT pending or inconclusive | Monitor. Clear nothing | `aat.maxInconclusive` budget, then `Blocked=stalled` |
| In Main, AAT pass | **Nothing** (corrected, V9). `delivery-issue` stays | `uatContainsLatestMerge` → In UAT |
| In UAT | Nothing. `delivery-issue` stays | Prod deploy → Done, `in-prod`, close |
| Done | Remove `delivery-issue`; the orchestrator's run is complete | — |
| Blocked = `launch-failed` or `stalled` (engine hold) | Diagnose only. Re-wake `deliver` after the cause is fixed. Never clear the hold | Engine clears when the stage rule no longer ends in a hold |

Subscriptions (Claude Code mechanics, V14): a PR-activity subscription for the PRs the run opened, and a
background watch on the issue's CI. No sleeps. Nothing subscribes to deploy workflows, because the engine acts on them.

### 4.7 AAT remediation routing

No AAT rubric is duplicated here. The skill links `.cursor/skills/agent-acceptance/SKILL.md` Phase 7 and subscribes to the
`<!-- v2:aat verdict=… -->` marker. The table in §4.6 is the routing. Retry budget (`aat.maxInconclusive`) and launch
backoff are engine rules and are cited, not restated.

### 4.8 Stop and handoff table

| Hold | Set by | Orchestrator action |
|---|---|---|
| `question` | Agent or owner | Stop. Post the question once. Wait for the owner |
| `decision`, `sensitive`, `paused` | Owner or engine | Stop. Report. Do not clear |
| `no-convergence` | Engine | Stop. Report |
| `launch-failed`, `stalled` | Engine | Diagnose, fix the cause, re-wake. Do not clear the hold |
| Driver timeout with an open PR | Skill | Comment the next step on the PR and the issue. Leave `busy` set (babysit-gap §Driver lifetime). Phase 3 fallback or `continue delivery #n` |

### 4.9 Definition of done for the skill

Before `finish-work` (the delivery leg ends):

- [ ] Every delivery DoD box is ticked (`dodComplete`; `<!-- soak-dod:defer -->` rows excepted).
- [ ] No open PR linked to the issue. Merges into `main` count; merges into integration branches do not (delivery contract).
- [ ] A merge into `main` exists, when the work needed code.
- [ ] `## Docs` on every behaviour PR, and canonical-docs sync cited on the issue.
- [ ] Self-review recorded on the issue (atomic PR) or the release PR (programme).

After `finish-work`, the orchestrator only monitors until Done. On Done: `in-prod` is present, the issue is closed,
and `busy`, `delivery-issue` and `analyse-only` are not set.

Must not: close the issue; write `Stage`, `Acceptance` or `Acceptance fail reason`; run `/AgentAcceptance` in the same
session that shipped; use `Closes`, `Fixes` or `Resolves`; use `composer-2.5`.

## 5. Implementation plan

Each step is one outcome (`atomic-pr-policy.md`). Steps 1–2 are prerequisites. The skill (step 5) cannot ship before them.

| Step | Deliverable | Files | Tests | Docs gate | Blocked on |
|---|---|---|---|---|---|
| 0 | This doc (PR for review) | `docs/agent-efficiency/changes/delivery-issue-skill.md` | none (docs only) | `Docs: N/A — proposal doc, no behaviour change` | — |
| 1 | babysit-gap Phase 1 (policy subsection, `METHOD_PROMPTS.PR`, guard markers) | per babysit-gap §1a–1e | `check_babysit_skill_family` test | `autonomous-pr-policy.md`, `github-issue-workflow-behaviour.md` | Owner acceptance of babysit-gap |
| 2 | `mission=deliver` | `scripts/issue_pipeline_mission.js` (`MISSIONS`, `missionGuard` branch for deliver), `scripts/issue_pipeline_wake.js` (usage text) | extend `scripts/issue_pipeline_v2_mission.test.js`: Ready allowed; Backlog/To do/In analysis → `premature`; In Main/In UAT/Done → `out-of-scope`; `analyse` unchanged; missing issue → refused | `docs/agent-efficiency/github-issue-workflow-behaviour.md` (mission table), this doc status → `in-delivery` | D1, D2 |
| 3 | Fail-closed `Method: PR` check (optional) | `scripts/issue_pipeline_v2_launch.js` (`deliveryMethod` or a new validator) | new test cases | `github-issue-workflow-behaviour.md` §Launch | D4 |
| 4 | Decision rows and label | `docs/agent-efficiency/github-issue-workflow-wire.md` (PIPE-V2-D-DELIVER-*), `docs/agent-efficiency/github-labels.md` (`delivery-issue`) | label list test if one exists | same | D1–D3 |
| 5 | Skill files | `.cursor/skills/delivery-issue/SKILL.md`; `.claude/skills/delivery-issue/SKILL.md` (same procedure; separately authored, Claude mechanics in §4.6) | `scripts/check_babysit_skill_family.js` pattern: a check that the skill points to the policy and does not restate the base-branch table | `docs/agent-efficiency/github-issue-workflow-operations.md` cross-link | Steps 1–4 |
| 6 | Soak: one Ready issue per method (`PR`, `light-plan`, `execute-plan`) under the soak label | `delivery-issue-soak-evidence.md`, SOAK-REG-002 in catalog, `check_delivery_issue_skill.js` | automated pass; live deferred to soak box | soak evidence file | **Automated done**; live **deferred** (D6) |

**Engineering notes for step 2:**

- `missionGuard` returns `{ type: 'none', reason, row }`. Use `mission.deliver.premature` and `mission.deliver.out-of-scope` as the row names, matching the `mission.analyse.*` pattern.
- Ready with `mission=deliver` still passes through the `analyse-only` check. That is intended (§4.3, step 1).
- Keep `board` unchanged. Scheduled ticks must not see `deliver`.

**Engineering notes for step 5:**

- The two mirrors carry the same procedure, not identical text. The existing `analyse-issue` pair already differs in its frontmatter description, so keep them in sync by review, not by copying. Claude Code waits with a background watch, a PR-activity subscription, or `ScheduleWakeup` (≥1200 s when idle). It never sleeps.
- Frontmatter `disable-model-invocation: true`, matching `analyse-issue`.

## 6. Non-goals (v1)

- Replacing the execute-plan driver, or changing its merge gates.
- Changing AAT rubric, retry budgets, or the prod gate (`scripts/ci/aat-prod-gate.js`).
- A `release` or `acceptance` mission (§3 item 1).
- Making `/delivery-issue` the default for cron `ready.launch`. Opt-in until soak (D6).
- Phase 2 and 3 of babysit-gap (tracked as dependencies, not in this skill).

## 7. Decisions needed from the owner

Each has a recommendation. Nothing in §5 after step 0 starts until the blocking decisions are accepted.

| ID | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | Single `deliver` mission; drop `acceptance` and `release` | **Accepted (owner, 2026-11-26)** | Step 2 — shipped |
| D2 | Add a `delivery-issue` label (owner-invoked only) | **Accepted (owner, 2026-11-26)** | Steps 2, 4 — shipped |
| D3 | `/delivery-issue` babysit/merge authority | **Accepted (owner, 2026-11-26)** — PIPE-V2-D-DELIVER-005 in `AGENTS.md` §Autonomy | Step 5 — shipped |
| D4 | Fail-closed `Method: PR` on multi-phase body | **Accepted (owner, 2026-11-26)** — PIPE-V2-D-DELIVER-006 | Step 3 — shipped |
| D5 | Umbrella: report blockers only | **Accepted (owner, 2026-11-26)** | Step 5 — in skill |
| D6 | Opt-in command only; cron stays `board`. Soaks per method are best-effort — failures or manual steps go to the soak box issue, not a merge gate | **Accepted (owner, 2026-11-26)** | Step 6 |

Proposed decision rows (text for `github-issue-workflow-wire.md` once accepted):

- **PIPE-V2-D-DELIVER-001** — `mission=deliver` runs at Ready and In progress only; Backlog to In analysis gives `mission.deliver.premature`; In Main and later give `mission.deliver.out-of-scope`.
- **PIPE-V2-D-DELIVER-002** — `/delivery-issue` removes `analyse-only` only as the owner's act, recorded in the issue.
- **PIPE-V2-D-DELIVER-003** — `/delivery-issue` never runs AAT and never writes `Stage`, `Acceptance` or `Acceptance fail reason`.
- **PIPE-V2-D-DELIVER-004** — After an AAT fail, the orchestrator waits for the engine (`scope`) or the follow-up runs (`implementation`, `quality`). It does not wake delivery itself.
- **PIPE-V2-D-DELIVER-005** — `/delivery-issue` invocation authorises babysitting and merging only PRs whose author is a pipeline login or in the issue's `prAuthors`. The authority text lives in `autonomous-pr-policy.md` §Autonomy; the skill cites it.

## 8. Open verification (before step 2)

Closed in review:

- **V18 (closed):** `timeout-minutes: 45` is set at `.github/workflows/pipeline-claude-run.yml` line 49.
- **`finish-work` (closed):** the command is `node scripts/github_issue_workflow.js finish-work --issue <n>`, per `.cursor/skills/light-plan/SKILL.md` §Pre-UAT green.
- **Mirror text (closed, changes §5 step 5):** `.claude/skills/analyse-issue/SKILL.md` is not identical to its Cursor counterpart (its description is Claude-specific), so mirrors are separately authored.

Closed in review (additional):

- **V15 (closed):** pipeline v2 cron `:11,:41 * * *` is in `.github/workflows/issue-pipeline-v2.yml` (`on.schedule`); sweeper policy PIPE-V2-HT-R-003 is cited from [github-issue-workflow-operations.md](../github-issue-workflow-operations.md).
- **Symlink or copy (closed):** `.claude/skills/delivery-issue/SKILL.md` is a separate file (not a symlink); it delegates to `.cursor/skills/delivery-issue/SKILL.md` via `../../../.cursor/...`.
