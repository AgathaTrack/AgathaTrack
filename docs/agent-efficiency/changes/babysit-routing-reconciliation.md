---
title: Babysit driver routing — review and fix spec
owner: Documentation Team
audience: both
status: proposed
last_updated: 2026-11-26
tags: [agent-efficiency, babysit, policy, routing]
---

# Babysit driver routing — review and fix spec

> **Proposal (2026-11-26), draft for review.** This document changes no behaviour and no canonical text. It reviews the
> repo-wide babysit reconciliation, corrects it where the repo disagrees, and specifies the fix as a sequence of small PRs.
>
> **Revision 4 (2026-11-26).** Owner confirmed all readings from Revision 3 (§7). Dependabot landing stays on `/babysit-uat`.
> Red-`main` ownership decided (§8 C1): an `e2e-debug` session starts independently; no scheduled check for now. Earlier
> revisions: driver definition, rows 1/2/13 notes, gap-doc deduplication, spawn-sprint pointer, phase mapping, driver lifetime.
>
> Related: [issue-pipeline-babysit-gap.md](../plans/issue-pipeline-babysit-gap.md) (pipeline PR driver, #2658, merged). That doc
> owns the pipeline problem; this doc owns the routing table the pipeline fix depends on.

## 1. Summary

The babysit family is mostly coherent. Its real problems are:

1. **Stale v1 wording** that still tells agents to run `/babysit-plus` or `/babysit-uat` on execute-plan PRs, although v2 says `tick` and the driver own those PRs.
2. **Two documents disagree on light-plan phase PRs.** `merge-policy.mdc` says "not `/babysit-plus`"; `light-plan/SKILL.md` requires it.
3. **No single routing table.** The driver for a PR is decided by reading five files, and the rule is not written down in one place.
4. **Missing autonomy scope.** `AGENTS.md` §Autonomy lists who may merge. It does not list pipeline PRs or sprint PRs.
5. **Pre-UAT on every agent merge to `main` is an unpriced CI cost.** Decided under D1: agents no longer watch pre-UAT by default.

The fix is one routing table in `autonomous-pr-policy.md`, with every skill and rule that names a driver linking to it, plus a checker that fails if the table is removed or contradicted.

**Default after D1.** An agent PR to `main` that has a driver gets `/babysit-plus`, except dependabot landings. Pre-UAT then runs asynchronously in Actions and nothing in the agent session watches it. Four routes use `/babysit-uat` (rows 2, 4, 8b, 12). Row 15 is unchanged: an unprompted agent PR has no driver and the user merges it.

## 2. Review of the reconciliation

Each claim was checked against the repo at `63c1b9c`.

| # | Reconciliation claim | Verdict | Evidence |
|---|----------------------|---------|----------|
| R-1 | `autonomous-pr-policy.md` §Layering still teaches v1 for execute-plan | **Confirmed** | The top Layering table row for `/execute-plan` and the sentence "During `/execute-plan`, use **babysit-plus** … **babysit-uat** …" have no v2 carve-out. The v2 subsection below does carve out, so the top of the section contradicts it. |
| R-2 | `babysit-uat/SKILL.md` "When to use" has no v2 carve-out | **Confirmed** | The title block says v2 uses `tick`. The table still lists "`/execute-plan` intermediate → `/babysit-plus`" and "final PR → `/babysit-uat`" with no v2 note. |
| R-3 | `babysit-plus/SKILL.md` line 19 teaches v1 | **Confirmed** | Line 19: "During `/execute-plan`, use **/babysit-plus** for intermediate phase PRs …". |
| R-3a | `babysit-plus` lines 228–259 teach v1 | **Partly wrong** | The §8 and "Execute-plan (v2)" text at those lines is v2-aware. The stale line is the "Related skills" table row "`/execute-plan` … babysit+ on phases; babysit-uat on final main merge". |
| R-4 | `merge-policy.mdc` says light-plan phase PRs use "light merge" and not `/babysit-plus` | **Confirmed** | `merge-policy.mdc` light-plan bullet. `light-plan/SKILL.md` line 43 says every phase and sync PR is driven by `/babysit-plus`. |
| R-5 | Pipeline Ready 2 routes every PR to `/babysit-plus`, whatever the base | **Confirmed; already has a proposed fix** | `issue-pipeline-automation.md` line 81. The reconciliation did not cite #2658, whose §Decision rule table gives `main` → `/babysit-uat`. Revision 4 changes that to `/babysit-plus` (D1). |
| R-6 | `issue_busy_watchdog.js` always says "resume with `/babysit-plus`" | **Confirmed, with a light-plan branch** | `scripts/issue_busy_watchdog.js` lines 55–58 already branch on the `light-plan` label. Only the non-light-plan branch is unconditional, and under D1 it is correct. |
| R-7 | `e2e_debug_status.mjs` requires `/babysit-uat` after a remedial PR | **Confirmed** | `scripts/e2e_debug_status.mjs:575`. Kept by row 2. |
| R-8 | `/dependabot-batch`: Phase 3 plus, Phase 5 uat | **Confirmed; Phase 5 stays uat** | Family table in `autonomous-pr-policy.md`. Owner confirmed dependabot landing keeps uat (row 4). |
| R-9 | Default single-agent → `main` should be `/babysit-uat` | **Incorrect as a description of today** | `AGENTS.md` §Autonomy: merge is allowed only when the user asked to merge or babysit that PR, or an active programme owns it. "Otherwise the user merges." Today the default for an unprompted agent PR is **no agent merge** (row 15). |
| R-10 | No canonical line says what runs after a `cursor/*` PR goes to `main` | **Partly right** | True for the babysit skills. `AGENTS.md` §Autonomy already answers the merge question. What is missing is the driver choice once a babysit is requested. |
| R-11 | Sprint row in the matrix is "plus per agent PR?" | **Resolved (D3)** | Plus per agent PR; sprint → `main` is plus unless it touches a flagged shard (row 8b). |
| R-12 | §5 babysit vs plus vs uat table | **Confirmed** | `babysit/SKILL.md`, `babysit-plus/SKILL.md`, `babysit-uat/SKILL.md`. |
| R-13 | Pipeline plain `/babysit` is not a driver | **Confirmed (and stronger)** | `babysit` does not triage threads or gate the merge (family table: `gate` only). |

### Missed by the reconciliation

- **M-1 Autonomy scope.** `AGENTS.md:50` names `/light-plan`, `/e2e-debug` and `/dependabot-batch` as programmes that may merge. It does not name the issue pipeline or sprint integration. Decided under D2 (§7).
- **M-2 Pre-UAT cost.** Every merge to `main` triggers `pre-uat-e2e.yml`. `pr-review-cost-efficiency.md` §GitHub Actions minutes lists batching, integration programmes and a cap of four open `cursor/**` PRs with full CI as the levers. A babysit-uat watch can block an agent for up to 90 minutes. D1 removes that watch from the default path.
- **M-3 Model invocation.** `babysit`, `babysit-plus` and `babysit-uat` set `disable-model-invocation: true`. An unattended run cannot call them through the Skill tool, so a prompt that names them is not a driver. Define a driver as the skill file's procedure, which an agent reads and follows (§3). The gap doc's 1c prompt does this.
- **M-4 No consistency test.** `scripts/lib/babysit_skill_family_policy.js` checks only that resolve-all wording exists. Nothing checks that the routing table, `merge-policy.mdc`, `light-plan`, `babysit-uat`, `spawn-sprint-agents` and the watchdog agree.
- **M-5 Precedence.** Real cases collide: a light-plan release PR is programme-owned and targets `main`; a pipeline docs-only PR targets `main`; a remedial PR is both. The matrix needs an explicit order, §3.
- **M-6 Who owns a red `main`.** Under D1 nothing in the agent session watches pre-UAT for programme or pipeline PRs. Decided in §8 C1.

## 3. Routing model

**Driver.** A driver is the procedure in the linked skill file, plus the scripts that file names, followed by an agent in whatever session runs it. `disable-model-invocation: true` only stops the Skill tool from loading the file. It does not change which procedure counts as the driver. An unattended run is told to read the file and follow it (gap doc 1c). Every row below names a file, so a driver can always be checked.

**Precedence.** The first matching row wins. `/babysit-uat` contains all of `/babysit-plus`, so where a row says uat, uat is the driver.

| # | Case | Driver | Ends at |
|---|------|--------|---------|
| 1 | Active execute-plan v2 worker or driver on the PR (plan phase, sync, release or remedial) | `tick` and the driver, or the `triage-review` worker. **No babysit skill.** | Per [execute-plan-v2.md](../plans/execute-plan-v2.md) |
| 2 | Remedial PR from `/e2e-debug`, outside a v2 plan | `/babysit-uat` (mandatory) | Pre-UAT green on the merge SHA |
| 3 | `/dependabot-batch` CI phase | `/babysit-plus` | Squash merge |
| 4 | `/dependabot-batch` landing on `main` | `/babysit-uat` (owner-confirmed) | Pre-UAT green on the merge SHA |
| 5 | `/light-plan` phase or sync PR → integration | `/babysit-plus` (the light merge is the integration mechanic) | Squash merge, or merge commit for the release-conflict sync only |
| 6 | `/light-plan` release PR → `main` | `/babysit-plus` (D1, owner-confirmed) | Squash merge; pre-UAT runs async |
| 7 | Sprint agent PR → `cursor/sprint-*-integration-*` | `/babysit-plus` (D3) | Squash merge into integration |
| 8 | Sprint integration PR → `main`, no flagged shard | `/babysit-plus` (D3) | Squash merge; pre-UAT runs async |
| 8b | Sprint integration PR → `main`, touches a shard flagged by `babysit_uat_shard_risk.mjs` (owner-confirmed) | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 9 | Narrow CI-only or docs-only PR to `main`, `## Docs` states pre-UAT `N/A — <reason>` | `/babysit-plus` | Squash merge |
| 10 | Pipeline delivery (`Method: PR`) → integration base | `/babysit-plus` | Squash merge |
| 11 | Pipeline delivery → `main` | `/babysit-plus` (D1) | Squash merge; pre-UAT runs async |
| 12 | User invokes `/babysit-uat` on a PR | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 13 | User invokes `/babysit-plus` on a PR | `/babysit-plus` | Squash merge |
| 14 | User invokes `/babysit`, or asks for merge-ready only | `/babysit` | Gate exit `0`, no merge |
| 15 | Agent PR, no invocation, no programme | **None. The user merges** (AGENTS.md §Autonomy) | — |
| — | Any base not listed above, for a programme or pipeline PR | `/babysit-plus`; comment the unexpected base on the issue | Squash merge |

**`/babysit-uat` is the driver for rows 2, 4, 8b and 12 only.** Row 9 is subsumed: plus is already the driver for `main` PRs in the programme and pipeline routes. It stays as the record that pre-UAT is N/A in that PR's `## Docs`.

**Rows 1 and 2.** Plan remedials are owned by `tick` under row 1, not row 2. Row 2 covers standalone `/e2e-debug` remedials, and a plan's recovery only when the owner explicitly runs non-plan recovery.

**Row 8b.** The trigger is the output of `scripts/babysit_uat_shard_risk.mjs` for the PR. It is not a judgement call.

## 4. Suggested text (for the fix PRs, not applied here)

### 4.1 `autonomous-pr-policy.md` — §Layering, replace the execute-plan row and the sentence below the table

```markdown
| `/execute-plan` (v1 schema-only plans) | Multi-phase orchestrator; babysit+ on phases, babysit-uat on final main merge. **v2:** `tick` and the driver own merge, pre-UAT and promotion; no babysit skill runs on plan PRs. |

Routing for any PR is in §Driver routing below. Do not restate it elsewhere.
```

### 4.2 `autonomous-pr-policy.md` — new §Driver routing, and the gap-doc dedupe

Add the table from §3 of this doc, verbatim, under a `### Driver routing` heading inside §Babysit skill family. This becomes the only copy.

Phase 1 also adds one family-table row:

```markdown
| Issue-pipeline delivery PR (`Method: PR`, or R1 scope) | Yes — driver per §Driver routing rows 10–11 |
```

The gap doc's proposed §1a (its *Issue-pipeline delivery PRs* subsection with a base-branch table) is changed to a link to §Driver routing rows 10–11. It does not keep a second base-branch table. Gap doc acceptance criterion 3 and guard 1e are re-pointed at the policy table.

### 4.3 `merge-policy.mdc` — light-plan bullet

Replace "via the skill's **light merge** (not **`/babysit-plus`**)" and "release … via **`/babysit-uat`**" with:

```text
phase and sync PRs are driven by /babysit-plus (see autonomous-pr-policy §Driver routing row 5); the squash into integration is the light-plan integration mechanic. The release PR is driven by /babysit-plus (row 6).
```

### 4.4 `babysit-plus/SKILL.md` — line 19 and the Related skills table

- Line 19: "During `/execute-plan` (v1), use … . During v2, see autonomous-pr-policy §Driver routing row 1 (no babysit skill)."
- Related skills row for `/execute-plan`: "Multi-phase orchestrator — v1 only; v2 uses `tick` (see policy §Driver routing)."
- Add a line: "`/babysit-plus` is the default driver for `main`-bound programme and pipeline PRs (policy §Driver routing rows 6, 11). Pre-UAT then runs async."

### 4.5 `babysit-uat/SKILL.md` — "When to use" table

Replace the table with the four uat routes: remedial PR from `/e2e-debug` (row 2); dependabot landing on `main` (row 4); sprint integration PR that touches a flagged shard (row 8b); user invokes `/babysit-uat` (row 12). Mark the two existing execute-plan rows "v1 only", and add "`/execute-plan` **v2** plan PR → **none; `tick` owns it** (row 1)". Remove the light-plan release row; it now uses plus.

### 4.6 `issue-pipeline-automation.md` — Ready 2, PR path

Replace "PR → `/babysit-plus`" with "PR → driver per `autonomous-pr-policy.md` §Driver routing rows 10–11 (both `/babysit-plus`; pre-UAT async for `main`)". Gap doc 1b (delivery contract obligations 4–5) and 1c (launch prompt) also link to that section and do not restate the table.

### 4.7 `scripts/issue_busy_watchdog.js` — `buildWatchdogComment`

Under D1 every non-light-plan driver is `/babysit-plus`, so the base lookup is not needed. Light-plan (lines 55–58) stays as it is.

```js
const isLightPlan = (stale.labels || []).includes('light-plan');
const next = isLightPlan
  ? `Next step: resume the light-plan run (\`continue light-plan #${stale.number}\`).`
  : 'Next step: resume the owning PR with `/babysit-plus`, or clear `busy` and record the state here.';
```

Test: add cases to `scripts/issue_busy_watchdog.test.js` for light-plan (unchanged text) and for a non-light-plan issue (plus). No `pr_base` field is needed.

### 4.8 `scripts/lib/babysit_skill_family_policy.js` — consistency guard

Add invariants, enforced by `scripts/check_babysit_skill_family.js` and its test:

1. `autonomous-pr-policy.md` contains `### Driver routing` with a row for each of `/babysit`, `/babysit-plus`, `/babysit-uat`.
2. `merge-policy.mdc` does not contain "not `/babysit-plus`" or "not **`/babysit-plus`**", and its light-plan bullet does not name `/babysit-uat`.
3. `babysit-plus/SKILL.md` and `babysit-uat/SKILL.md` mention "v2" in the same section as `execute-plan`.
4. In `issue_busy_watchdog.js`, the `/babysit-plus` literal is the non-light-plan branch and the light-plan branch still names `continue light-plan`.
5. Only one base-branch table exists in `docs/`: §Driver routing. The row text "Integration branch (`cursor/*-integration-*`" outside the policy is an error (it may appear in a link).
6. `.cursor/skills/spawn-sprint-agents/SKILL.md` names §Driver routing rows 7, 8 and 8b (see §4.9).
7. `.cursor/skills/light-plan/SKILL.md` §Release names `/babysit-plus` and §Driver routing row 6, not `/babysit-uat`.

These are text invariants, like the existing resolve-all check. They stop the drift this review found. They do not prove the routing is right.

### 4.9 `.cursor/skills/spawn-sprint-agents/SKILL.md` — driver pointers

- Step 5 (agent branches): "Agent PRs into the integration branch are driven by `/babysit-plus` (policy §Driver routing row 7)."
- Step 8 (single PR integration → `main`): "The coordinator drives this PR with `/babysit-plus` (policy §Driver routing row 8). Use `/babysit-uat` only if the PR touches a flagged shard (row 8b)." Step 8 currently names no driver.

Pointers only. No other change to the skill's procedure.

## 5. Phased implementation

| Phase | Gap doc item | PR scope | Canonical doc touched | Depends on |
|-------|--------------|----------|----------------------|-----------|
| 0 | — | This spec | None (proposal in `changes/`) | — |
| 1 | 1a (policy part) | §Driver routing table, family row (§4.2), gap doc §1a subsection replaced by a link, babysit-uat table (§4.5), babysit-plus (§4.4) | `autonomous-pr-policy.md` (canonical), two skills | Owner approval of §3 (C1 decided) |
| 2 | 1e (guard) and light-plan | Guard (§4.8); `merge-policy.mdc` (§4.3); `light-plan/SKILL.md` §Release; spawn pointer (§4.9) | `merge-policy.mdc`, `light-plan`, `spawn-sprint-agents` | Phase 1 |
| 3 | not in the gap doc | Watchdog (§4.7) and test | `scripts/issue_busy_watchdog.js`, `autonomous-pr-policy.md` (behaviour note) | Phase 1 |
| 4 | 1b and 1c, then gap Phases 2 and 3 | Delivery-contract obligations (revised R7, §8 C2), launch prompt, event trigger, engine fallback | Per gap doc | Phase 1, Phase 5 |
| 5 | — | `AGENTS.md` §Autonomy (D2 wording, plus light-plan release) | `AGENTS.md` | Owner approval of the wording |

Phases 1 and 2 cover the policy and guard items of gap Phase 1 (1a and 1e). Phase 4 must not ship them again. Gap item 1d is dropped and needs no work.

Each phase is one outcome and one PR, per [atomic-pr-policy.md](../atomic-pr-policy.md).

## 6. Acceptance criteria

- A PR's driver can be read from one table (`autonomous-pr-policy.md` §Driver routing). No other file names a different driver for a case in §3.
- `/babysit-uat` is named as the driver only for rows 2, 4, 8b and 12. No skill or rule outside the table says otherwise.
- A v2 plan PR is never given a babysit skill by any skill or rule (grep for `babysit` in `.cursor/skills/execute-plan/` and the babysit skills shows only the v1 notes).
- `check_babysit_skill_family.js` fails when the routing table is removed, a driver row is deleted, or light-plan §Release names `/babysit-uat`.
- The watchdog picks `/babysit-plus` for non-light-plan issues, with tests for light-plan and non-light-plan.
- After Phase 1, `docs/` contains one base-branch table (§Driver routing), and the gap doc's pipeline subsection links to it.
- After Phase 2, `.cursor/skills/spawn-sprint-agents/SKILL.md` names rows 7, 8 and 8b.
- A docs-only PR to `main` produces `N/A — <reason>` in `## Docs`, and the driver is plus.
- No model identifier or user identifier appears in any artifact this change creates.

## 7. Decisions (owner, 2026-11-26)

Each was an escalation under `autonomous-pr-policy.md` §Escalation. Owner answers are recorded with the reading applied.

**D1 — Pre-UAT scope. Decided.** Owner: *"Only programme/plans, pipeline light plans and single PRs rely on the async Actions pre-UAT → babysit-plus only."*
- Applied: `/babysit-plus` for programme and light-plan release PRs (row 6), pipeline PRs to `main` (row 11), and single PRs (row 13 when asked, row 15 otherwise). Pre-UAT runs asynchronously in Actions.
- Owner answers on Revision 3 readings: **dependabot landing keeps uat** (row 4); **remedial PRs from `/e2e-debug` stay uat** (row 2); **light-plan release is plus** (row 6).
- `babysit-uat` is used only for rows 2, 4, 8b and 12.

**D2 — Merge authority. Decided.** Owner: *"Yes, limited to the table's driver rows."*
- Applied: `AGENTS.md` §Autonomy covers pipeline PRs (rows 10–11) and sprint integration PRs (rows 7–8b). Wording is Phase 5. Scope stays with engine-dispatched PRs and the sprint coordinator's PRs.
- The same edit changes light-plan release from uat to plus (row 6), which the owner confirmed.

**D3 — Sprint driver. Decided.** Owner: *"`/babysit-plus` per agent PR, and for the single sprint → `main` PR. No need for UAT unless it touches something specific."*
- Applied: plus for rows 7 and 8. Row 8b (uat) fires when the PR touches a shard flagged by `scripts/babysit_uat_shard_risk.mjs`. Owner confirmed "specific" means that trigger.

## 8. Consequences and risks

- **C1 — Who owns a red `main`. Decided.** Owner: an `e2e-debug` session starts independently, or fixes deploy if needed. There is no scheduled check for now.
  - Implementation note: nothing in the repo starts `e2e-debug` automatically on a red `main` today. A grep of `.github/workflows` and `.github/scripts` finds no trigger. `scripts/e2e_debug_status.mjs` and `scripts/quality/ci-health-kpis.mjs` mention it but do not start it. So "starts independently" means a session started by a person or an agent, not by an event. Revisit when a scheduled check is wanted.
  - Consequence: a red pre-UAT on a programme or pipeline PR can sit until someone starts `e2e-debug`. `promote-uat` does not run and the engine does not set `In UAT` in the meantime.
- **C2 — Gap doc R7 is superseded.** R7 says the `Method: PR` delivery end state is "Pre-UAT green on the merge SHA, then DoD ticks and `finish-work`". Under D1 that end state is squash merge, then DoD and `finish-work`, with pre-UAT async. The gap doc's Phase 1b wording (obligation 4) and the "Driver lifetime" section change in Phase 4.
- **C3 — Light-plan changes beyond the routing table.** `light-plan/SKILL.md` §Release has an action table whose rows wait for pre-UAT green, tick DoD and run `finish-work` only then. Those rows move to "merged; DoD ticks and `finish-work` at merge" in Phase 2. That is a change to a programme skill and needs owner review of the wording.
- **C4 — Engine `In UAT` still depends on pre-UAT.** `promote-uat` tags only after pre-UAT passes (`pre-uat-e2e.yml` line 114), and the engine's `uatContainsLatestMerge` check reads the UAT deploy. The routing table does not change that. C1 determines who acts when pre-UAT fails.
- **Route churn.** Changing rows 6, 8, 11 changes which PRs the agent watches. Ship Phase 1 with the table as decided.
- **Driver lifetime.** The 45-minute timeout in `pipeline-claude-run.yml` still applies to the uat rows (2, 4, 8b, 12): a uat driver can run the pre-UAT watch for up to 90 minutes and remedial rounds after that. The gap doc's handoff to its Phase 3 fallback covers them. Raising the timeout is still an owner CI decision.
- **Guard false positives.** Text invariants can fail on harmless edits. Keep them to the seven in §4.8 and say so in the failure message.
- **Pipeline timing.** The gap doc's Phase 2 needs a non-skill procedure entry point (M-3, and the gap doc's own design note). Phase 1 here does not change that.

## 9. Not in scope

- Changing any babysit skill's procedure (triage, gate, merge steps).
- The pipeline driver's implementation (gap doc).
- Rewriting `execute-plan-schema.md` or the v1 snapshot path. Mark v1 as v1 only.
- Mass-migrating `.agents/plans/*.md`. Those are historical.
- Changing `pre-uat-e2e.yml`, `promote-uat` or any Actions workflow. A scheduled red-`main` check (deferred per C1) would be a separate CI decision.
