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
> Related: [issue-pipeline-babysit-gap.md](../plans/issue-pipeline-babysit-gap.md) (pipeline PR driver, #2658). That doc owns the
> pipeline problem; this doc owns the routing table that the pipeline fix depends on.

## 1. Summary

The babysit family is mostly coherent. Its real problems are:

1. **Stale v1 wording** that still tells agents to run `/babysit-plus` or `/babysit-uat` on execute-plan PRs, although v2 says `tick` and the driver own those PRs.
2. **Two documents disagree on light-plan phase PRs.** `merge-policy.mdc` says "not `/babysit-plus`"; `light-plan/SKILL.md` requires it.
3. **No single routing table.** The driver for a PR is decided by reading five files, and the rule is not written down in one place.
4. **Missing autonomy scope.** `AGENTS.md` §Autonomy lists who may merge. It does not list pipeline PRs or sprint PRs, so the authority for an unattended pipeline merge is unstated.
5. **Pre-UAT on every agent merge to `main` is an unpriced CI cost.** The reconciliation proposes it as a default without weighing the existing CI-minute levers.

The fix is one routing table in `autonomous-pr-policy.md`, with every skill and rule that names a driver linking to it, plus a checker that fails if the table is removed or contradicted.

## 2. Review of the reconciliation

Each claim was checked against the repo at `63c1b9c`.

| # | Reconciliation claim | Verdict | Evidence |
|---|----------------------|---------|----------|
| R-1 | `autonomous-pr-policy.md` §Layering still teaches v1 for execute-plan | **Confirmed** | The top Layering table row for `/execute-plan` and the sentence "During `/execute-plan`, use **babysit-plus** … **babysit-uat** …" have no v2 carve-out. The v2 subsection below does carve out, so the top of the section contradicts it. |
| R-2 | `babysit-uat/SKILL.md` "When to use" has no v2 carve-out | **Confirmed** | The title block says v2 uses `tick`. The table still lists "`/execute-plan` intermediate → `/babysit-plus`" and "final PR → `/babysit-uat`" with no v2 note. |
| R-3 | `babysit-plus/SKILL.md` line 19 teaches v1 | **Confirmed** | Line 19: "During `/execute-plan`, use **/babysit-plus** for intermediate phase PRs …". |
| R-3a | `babysit-plus` lines 228–259 teach v1 | **Partly wrong** | The §8 and "Execute-plan (v2)" text at those lines is v2-aware. The stale line is the "Related skills" table row "`/execute-plan` … babysit+ on phases; babysit-uat on final main merge". |
| R-4 | `merge-policy.mdc` says light-plan phase PRs use "light merge" and not `/babysit-plus` | **Confirmed** | `merge-policy.mdc` light-plan bullet. `light-plan/SKILL.md` line 43 says every phase and sync PR is driven by `/babysit-plus`. |
| R-5 | Pipeline Ready 2 routes every PR to `/babysit-plus`, whatever the base | **Confirmed; already has a proposed fix** | `issue-pipeline-automation.md` line 81. The reconciliation did not cite #2658, whose §Decision rule table already gives `main` → `/babysit-uat`. |
| R-6 | `issue_busy_watchdog.js` always says "resume with `/babysit-plus`" | **Confirmed** | `scripts/issue_busy_watchdog.js:58`. |
| R-7 | `e2e_debug_status.mjs` requires `/babysit-uat` after a remedial PR | **Confirmed** | `scripts/e2e_debug_status.mjs:575`. |
| R-8 | `/dependabot-batch`: Phase 3 plus, Phase 5 uat | **Confirmed** | Family table in `autonomous-pr-policy.md`. |
| R-9 | Default single-agent → `main` should be `/babysit-uat` | **Incorrect as a description of today** | `AGENTS.md` §Autonomy: merge is allowed only when the user asked to merge or babysit that PR, or an active programme owns it. "Otherwise the user merges." Today the default for an unprompted agent PR is **no agent merge**. Making `/babysit-uat` the default is a new proposal with a CI cost (§7, D1). |
| R-10 | No canonical line says what runs after a `cursor/*` PR goes to `main` | **Partly right** | True for the babysit skills. `AGENTS.md` §Autonomy already answers the merge question. What is missing is the driver choice once a babysit is requested. |
| R-11 | Sprint row in the matrix is "plus per agent PR?" | **Correct, and left open** | `merge-policy.mdc` names sprint integration branches and agent merges into them. No skill or policy row names a driver for sprint agent PRs. See D3. |
| R-12 | §5 babysit vs plus vs uat table | **Confirmed** | `babysit/SKILL.md`, `babysit-plus/SKILL.md`, `babysit-uat/SKILL.md`. |
| R-13 | Pipeline plain `/babysit` is not a driver | **Confirmed (and stronger)** | `babysit` does not triage threads or gate the merge (family table: `gate` only). |

### Missed by the reconciliation

- **M-1 Autonomy scope.** `AGENTS.md:50` names `/light-plan`, `/e2e-debug` and `/dependabot-batch` as programmes that may merge. It does not name the issue pipeline or sprint integration. The pipeline gap doc's R7 requires a delivery agent to merge and hold through pre-UAT. That is not authorised by the text as it stands. See D2.
- **M-2 Pre-UAT cost.** Every merge to `main` already triggers `pre-uat-e2e.yml`. `pr-review-cost-efficiency.md` §GitHub Actions minutes lists batching, integration programmes and a cap of four open `cursor/**` PRs with full CI as the levers. A babysit-uat watch can block an agent for up to 90 minutes (`babysit_uat_watch_preuat.sh --timeout-min 90`). Defaulting every agent PR to uat multiplies both.
- **M-3 Model invocation.** `babysit`, `babysit-plus` and `babysit-uat` set `disable-model-invocation: true`. An unattended run cannot call them through the Skill tool, so a prompt that names them is not a driver. The pipeline fix must give the driver procedure a non-skill entry point, as the gap doc's Phase 2 does.
- **M-4 No consistency test.** `scripts/lib/babysit_skill_family_policy.js` checks only that resolve-all wording exists. Nothing checks that the routing table, `merge-policy.mdc`, `light-plan`, `babysit-uat` and the watchdog agree.
- **M-5 Precedence.** The reconciliation's matrix has two axes, base and programme. Real cases collide: a light-plan release PR is programme-owned and targets `main`; a pipeline docs-only PR targets `main`; a remedial PR is both. The matrix needs an explicit order, §3.

## 3. Routing model

**Precedence.** The first matching row wins. `/babysit-uat` contains all of `/babysit-plus`, so when a row allows either, uat is the choice unless a higher row says plus.

| # | Case | Driver | Ends at |
|---|------|--------|---------|
| 1 | Active execute-plan v2 worker or driver on the PR (plan phase, sync, release or remedial) | `tick` and the driver, or the `triage-review` worker. **No babysit skill.** | Per [execute-plan-v2.md](../plans/execute-plan-v2.md) |
| 2 | Remedial PR from `/e2e-debug` | `/babysit-uat` (mandatory) | Pre-UAT green on the merge SHA |
| 3 | `/dependabot-batch` CI phase | `/babysit-plus` | Squash merge |
| 4 | `/dependabot-batch` landing on `main` | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 5 | `/light-plan` phase or sync PR → integration | `/babysit-plus` (the light merge is the integration mechanic, not a lighter driver) | Squash merge, or merge commit for the release-conflict sync only |
| 6 | `/light-plan` release PR → `main` | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 7 | Sprint agent PR → `cursor/sprint-*-integration-*` | `/babysit-plus` (D3) | Squash merge into integration |
| 8 | Sprint integration PR → `main` | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 9 | Narrow CI-only or docs-only PR to `main`, `## Docs` states pre-UAT `N/A — <reason>` | `/babysit-plus` (the existing exception) | Squash merge |
| 10 | Pipeline delivery (`Method: PR`) → integration base | `/babysit-plus` | Squash merge |
| 11 | Pipeline delivery → `main` | `/babysit-uat` (D1) | Pre-UAT green on the merge SHA |
| 12 | User invokes `/babysit-uat` on a PR | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 13 | User invokes `/babysit-plus` on a PR | `/babysit-plus` | Squash merge |
| 14 | User invokes `/babysit`, or asks for merge-ready only | `/babysit` | Gate exit `0`, no merge |
| 15 | Agent PR, no invocation, no programme | **None. The user merges** (AGENTS.md §Autonomy) | — |
| — | Any base not listed above, for a programme or pipeline PR | `/babysit-plus`; comment the unexpected base on the issue | Squash merge |

Row 9 is checked before rows 10–11, so a pipeline docs-only PR to `main` gets plus, not uat. The exception needs the `## Docs` line, as the PR template already requires.

## 4. Suggested text (for the fix PRs, not applied here)

### 4.1 `autonomous-pr-policy.md` — §Layering, replace the execute-plan row and the sentence below the table

```markdown
| `/execute-plan` (v1 schema-only plans) | Multi-phase orchestrator; babysit+ on phases, babysit-uat on final main merge. **v2:** `tick` and the driver own merge, pre-UAT and promotion; no babysit skill runs on plan PRs. |

Routing for any PR is in §Driver routing below. Do not restate it elsewhere.
```

### 4.2 `autonomous-pr-policy.md` — new §Driver routing

Add the table from §3 of this doc, verbatim, under a `### Driver routing` heading inside §Babysit skill family. This becomes the only copy. The pipeline gap doc's decision table is replaced by a link to it (its R4 already asks for the table to live in the policy).

### 4.3 `merge-policy.mdc` — light-plan bullet

Replace "via the skill's **light merge** (not **`/babysit-plus`**)" with:

```text
phase and sync PRs are driven by /babysit-plus (see autonomous-pr-policy §Driver routing row 5); the squash into integration is the light-plan integration mechanic
```

### 4.4 `babysit-plus/SKILL.md` — line 19 and the Related skills table

- Line 19: "During `/execute-plan` (v1), use … . During v2, see autonomous-pr-policy §Driver routing row 1 (no babysit skill)."
- Related skills row for `/execute-plan`: "Multi-phase orchestrator — v1 only; v2 uses `tick` (see policy §Driver routing)."

### 4.5 `babysit-uat/SKILL.md` — "When to use" table

Add a first row: "`/execute-plan` **v2** plan PR (any) → **none; `tick` owns it** (policy §Driver routing row 1)." Mark the two existing execute-plan rows "v1 only".

### 4.6 `issue-pipeline-automation.md` — Ready 2, PR path

Replace "PR → `/babysit-plus`" with "PR → driver per `autonomous-pr-policy.md` §Driver routing rows 9–11 (base-dependent)".

### 4.7 `scripts/issue_busy_watchdog.js` — line 58

Make the message depend on the PR base. The watchdog must have the base; if it does not, fetch `baseRefName` with the existing GitHub client. If the base cannot be read, use `/babysit-plus` and say the base is unknown (the cheaper choice).

```js
const driver = prBase === 'main'
  ? '`/babysit-uat` (base is main: pre-UAT must go green on the merge SHA)'
  : '`/babysit-plus`';
const next = prBase
  ? `Next step: resume the owning PR with ${driver}, or clear \`busy\` and record the state here.`
  : 'Next step: base unknown; resume the owning PR with `/babysit-plus`, or clear `busy` and record the state here.';
```

Test: add cases to `scripts/issue_busy_watchdog.test.js` for `main`, an integration branch, and unknown base.

### 4.8 `scripts/lib/babysit_skill_family_policy.js` — consistency guard

Add invariants, enforced by `scripts/check_babysit_skill_family.js` and its test:

1. `autonomous-pr-policy.md` contains `### Driver routing` with a row for each of `/babysit`, `/babysit-plus`, `/babysit-uat`.
2. `merge-policy.mdc` does not contain "not `/babysit-plus`" or "not **`/babysit-plus`**".
3. `babysit-plus/SKILL.md` and `babysit-uat/SKILL.md` mention "v2" in the same section as `execute-plan`.
4. `issue_busy_watchdog.js` contains no unconditional "`/babysit-plus`" literal outside the unknown-base branch.

These are text invariants, like the existing resolve-all check. They stop the drift this review found. They do not prove the routing is right.

## 5. Phased implementation

| Phase | PR | Scope | Canonical doc touched | Depends on |
|-------|----|-------|----------------------|-----------|
| 0 | This PR | This spec | None (proposal in `changes/`) | — |
| 1 | Docs | §4.1–4.6, §4.2 routing table, gap doc's table replaced by a link | `autonomous-pr-policy.md` (canonical) | Owner review of §3 |
| 2 | Docs + guard | §4.3–4.5, §4.8 checker and test | `merge-policy.mdc`, two skills | Phase 1 |
| 3 | Code | §4.7 watchdog and test | `docs/agent-efficiency/autonomous-pr-policy.md` (behaviour note only) | Phase 1 |
| 4 | Pipeline | [issue-pipeline-babysit-gap.md](../plans/issue-pipeline-babysit-gap.md) Phases 1–3 | Per that doc | Phase 1, D1, D2 |
| 5 | Owner | D1–D3 decisions, `AGENTS.md` §Autonomy line if D2 is "yes" | `AGENTS.md` (escalation) | Owner |

Each phase is one outcome and one PR, per [atomic-pr-policy.md](../atomic-pr-policy.md). Phase 1 can run before any decision because §3 rows 9, 10 and 11 are marked with their decision.

## 6. Acceptance criteria

- A PR's driver can be read from one table (`autonomous-pr-policy.md` §Driver routing). No other file names a different driver for a case in §3.
- A v2 plan PR is never given a babysit skill by any skill or rule (grep for `babysit` in `.cursor/skills/execute-plan/` and the babysit skills shows only the v1 notes).
- `check_babysit_skill_family.js` fails when the routing table is removed or a driver row is deleted.
- The watchdog picks the driver from the base, with tests for `main`, integration and unknown.
- A docs-only PR to `main` produces `N/A — <reason>` in `## Docs`, and the driver is plus.
- No model identifier or user identifier appears in any artifact this change creates.

## 7. Decisions for the owner

These are product and CI-cost decisions. The canonical docs do not answer them, so each is an escalation under `autonomous-pr-policy.md` §Escalation. The recommendation is given with each.

**D1 — Pre-UAT for agent PRs to `main` (CI cost and gate).**
- (a) Every driven PR to `main` runs `/babysit-uat`.
- (b) Only programme, pipeline and remedial PRs run `/babysit-uat`; single-agent plus PRs rely on the async Actions pre-UAT, which still runs.
- (c) The user chooses per PR.
- **Recommendation: (b).** It keeps the gate on the paths that must not leave red unattended, and it avoids a 90-minute watch on every agent PR. Confirm that the async Actions run is an acceptable gate for (b).

**D2 — Merge authority for pipeline and sprint PRs (autonomy).**
- Should `AGENTS.md` §Autonomy list the issue pipeline (`Method: PR`, Ready 2 → In progress) and sprint integration as programmes that may merge?
- **Recommendation: yes, for pipeline PRs that the owner has put in Ready 2, limited to the §3 driver rows and not extended to the owner's other work.** Without this line, the gap doc's R7 has no authority behind it.

**D3 — Sprint agent PR driver.**
- Who drives an agent PR into `cursor/sprint-*-integration-*`?
- **Recommendation: `/babysit-plus` per agent PR (row 7), and uat for the single sprint → `main` PR (row 8).** This matches how light-plan already works.

## 8. Risks

- **Route churn.** Changing rows 9–11 changes CI cost. Ship Phase 1 with D1 recorded as "pending" and rows 9–11 unchanged, then decide.
- **Guard false positives.** Text invariants can fail on harmless edits. Keep them to the four in §4.8 and say so in the failure message.
- **Pipeline timing.** The gap doc's Phase 2 needs a non-skill procedure entry point (M-3). Phase 1 here does not change that; it only makes the policy table the one it points to.

## 9. Not in scope

- Changing any babysit skill's procedure (triage, gate, merge steps).
- The pipeline driver's implementation (gap doc).
- Rewriting `execute-plan-schema.md` or the v1 snapshot path. Mark v1 as v1 only.
- Mass-migrating `.agents/plans/*.md`. Those are historical.
