---
title: Pipeline v2 acceptance simplification
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-26
folds_into: docs/domains/cross-domain/features/github-issue-workflow.md
last_updated: 2026-11-27
tags: [agent, pipeline, acceptance, aat, labels]
---

# Pipeline v2: acceptance simplification

**Proposal, not fully agreed.** Rows stay `Proposed` until their phase merges. **P2 shipped** in PR #2701: `PIPE-AAT-D-016`
and the behaviour rows live in [github-issue-workflow-wire.md](../github-issue-workflow-wire.md) and
[github-issue-workflow-behaviour.md](../github-issue-workflow-behaviour.md). Delete this file only when every phase below is
delivered (deletion guard in `/canonical-docs`).

Trigger: a review of [#2514](https://github.com/AgathaTrack/AgathaTrack/issues/2514) (a scripts-only change that went
In Main → In UAT → Done) found one acceptance outcome recorded in several places that can disagree, and a gate that cost an
agent run without adding evidence.

## Decisions requested

| # | Question | Recommendation |
|---|----------|----------------|
| Q1 | Keep the `AAT-progress` / `AAT-passed` / `AAT-failed` labels? | No. Retire them. The `Acceptance` field is the state; the `v2:aat` marker is the record |
| Q2 | Keep the `in-prod` label? | No. Done plus close is the signal for pipeline v2 issues; P2 removes `in-prod` from the engine and the legacy prod handler (legacy may still set Done/close outside v2 — see behaviour doc) |
| Q3 | Run AAT on every non-follow-up issue? | No. Skip it, per merge, when every merged PR touches only low-risk paths. Keep it for app, API, schema, workflow and security changes |
| Q4 | Which globs count as low-risk (§C default below)? | Start with `docs/**`, `scripts/pipeline_runners/**`, `.cursor/skills/**`. Add `scripts/issue_pipeline_v2*` only after a soak shows no regression, because an engine bug could otherwise auto-skip its own fix PR |

## Findings

All from #2514 unless stated. Times are UTC, 2026-11-26.

| # | Finding | Evidence |
|---|---------|----------|
| F1 | Three representations of one outcome: `AAT-*` labels (agent CLI, 3 states), the `Acceptance` field (engine, 5 states), the `v2:aat` marker (the only one the engine reads for the verdict) | `AAT-passed` 15:32:47; `Acceptance` written 15:33:39 |
| F2 | Labels go stale. `aat-reset` only posts a comment; a newer merge sets the field to Pending but leaves `AAT-passed` on the issue | `buildAatReset` in `scripts/issue_pipeline_v2_acceptance.js` |
| F3 | Some outcomes have no label: `inconclusive` removes all three; `Manual` and `Skipped` change none. The issue can show `AAT-passed` beside `Acceptance=Manual` | `aatLabelPlan` in `scripts/lib/github_issue_workflow_aat.js` |
| F4 | `AAT-progress` is never applied. The skill's Phase 0 depends on the agent running `aat-start`, and the engine does not set it. Zero issues in the repo carry it | label search: `AAT-progress` 0, `AAT-passed` 26, `AAT-failed` 2, `in-prod` 6 |
| F5 | AAT added no evidence on #2514: launch 15:30:59, verdict 15:32:46, re-ran the unit suites delivery had already run, skipped the app, and accepted a DoD that named the wrong doc | verdict comment; the skill's Phase 3 skip clause covers "docs/CI-only" only |
| F6 | The only two `AAT-failed` labels left are on two old light-plan issues, [#2342](https://github.com/AgathaTrack/AgathaTrack/issues/2342) and [#2363](https://github.com/AgathaTrack/AgathaTrack/issues/2363). Labels do not record fails later followed by a pass, so this undercounts | label search |
| F7 | `in-prod` has two writers (engine `apply.js`, legacy `issue-agent-handlers.js`) and is documented as non-authoritative. On #2514 it was set after a prod run where the Flutter frontend deploy was skipped and the prod notify job was skipped | run `45855657316` |
| F8 | The `aat-launch` marker names no agent. The verdict self-reports "claude-b" while the same login appears as "claude-a" elsewhere. The template says "Cursor run" for an Actions URL | thread comments |

**Evidence gap.** Label counts cannot say how often AAT caught a real problem, because fails are resolved by later passes.
Before Q3 is decided, count `Acceptance=Failed` transitions or `v2:aat verdict=fail` markers across closed issues, split by
changed paths. The recommendation in Q3 is weaker without that count, and the count is a **hard gate**: the P3 PR does not
merge until the census (method, date, result) is attached to it, and `aat.autoSkip.enabled` stays `false` until then.

## Proposal

### A. One acceptance signal (answers Q1)

- Retire `AAT-progress`, `AAT-passed`, `AAT-failed`.
- `Acceptance` (field) is the issue's state. The verdict comment and its `v2:aat` marker are the record. The engine's
  `aat-launch`, `aat-reset` and `aat-waive` comments are the audit trail.
- `aat-pass`, `aat-fail`, `aat-inconclusive` keep their names and the comment-then-marker order; they stop touching labels.
  `aat-start` is removed (it only set labels).
- A human who wants a board cue filters on the field. No replacement label.

### B. Retire `in-prod` (answers Q2)

- Done (`Stage`) plus the issue close event is the signal for v2-tracked issues (`ISSUE_PIPELINE_V2=on`). P2 stops adding
  `in-prod` in the engine Done path and in the legacy prod handler. The legacy handler may still set Done and close on
  non-v2 paths; behaviour doc §Scope documents that split. P2 does not remove the legacy Done writer, only the label.
- Out of scope here, filed as a follow-up: whether Done should require the production frontend deploy rather than any
  successful prod run (F7). It is a promotion-contract question, not a labelling one.

### C. Risk-tiered AAT (answers Q3)

AAT runs only when it can add evidence the delivery PR's own CI did not.

**Eligibility (auto-skip).** For the issue's merged PRs, every changed path matches a low-risk glob and none is a sensitive
path. Default globs for Q4, deliberately narrow:

| Include | Why |
|---------|-----|
| `docs/**` | No runtime behaviour |
| `scripts/pipeline_runners/**` | Runner code; verified by unit suites and `pre-push-changed.sh` |
| `.cursor/skills/**` | Agent instructions; reviewed under `agent-instructions.md` |

Deliberately **not** in the first list: `scripts/issue_pipeline_v2*` (the engine itself). Residual risk even with the narrow
list: a runner bug can still skip the review of its own fix. The mitigations are the intent doorbell, fail-closed reads and
the disabled-by-default rollout. Expanding the list is a later decision with its own soak.

Never auto-skipped: `server/**`, `flutter_app/**`, `db/**`, `.github/**`, `.cursor/agent-kernel/**`, `infra/**`, and any
path `isForbiddenPath` in `.github/scripts/agent-safety-lib.js` reports. `.github/**` is already a protected glob in
`scripts/lib/pipeline_path_gate.js`.

**Behaviour.**
1. At In Main, while `Acceptance` is unset and before `aat.launch`, the engine lists the files of every merged PR linked to the issue (not only the last
   merge: AAT judges the whole issue) and tests them against `aat.autoSkip.globs`.
2. All eligible → the engine sets `Acceptance=Skipped` and posts
   `<!-- v2:aat-waive merge=<sha> acceptance=skipped source=paths -->`, then follows the existing Skipped path to In UAT.
3. Fail closed. A files-API error, a `PullFilesOverflow` (over 3000 files), an unreadable PR, or no linked merged PR runs AAT.
4. Re-evaluated every merge. A waive with `source=paths` binds to one sha. A newer merge that is not eligible emits
   `aat-reset` (field back to Pending) and AAT runs. This differs deliberately from a human `Skipped`, which persists
   (PIPE-AAT-D-007) and is unchanged.
5. The non-gating intent-review doorbell runs for auto-skipped issues, so the "what shipped versus the issue" check is kept
   without an app run. This amends PIPE-AAT-D-005, which currently withholds it whenever AAT is on. Where it runs: today
   `decideInMain` returns `acceptanceInMain` whenever `aatGateOn`, so the existing `main.intent-request` and `main.intent`
   retry rows (and then `main.uat`) are never reached for a non-follow-up. Once an auto-skip waive (`source=paths`) is bound
   for the latest sha, `decideInMain` skips the `acceptanceInMain` return and falls through to those existing rows. No new
   intent row is added. The `then: ['request-intent-review']` on the In progress → In Main move
   (`progress.finished`) stays off for AAT-gated issues: at that point eligibility is not yet known, so the request is made
   from `main.intent-request` one tick later.
6. The production guard needs no change: `aatSatisfied` already treats a bound `Skipped` waive as satisfied, so `AAT_GATE`
   does not block an auto-skipped merge.

**What is lost.** A holistic second look on internal-tooling changes. Mitigations: the intent doorbell, delivery's own CI and
Definition of Done, and a human can force AAT on an eligible issue by setting `Acceptance=Pending` before it reaches In Main:
auto-skip fires only while the field is **unset**, so a human-set `Pending` (or any other value) is never overridden.

### D. Audit hygiene (independent of A to C, own PR)

- `aat-launch` carries `agent=<id>`; the verdict template says "Run:" not "Cursor run:".
- Skill Phase 3 gains an "internal tooling" clause so a skip cites a rule that exists. After C this applies only to issues
  that were forced onto AAT.
- The spec Definition of Ready checks that a doc path named in a DoD exists and is the authoritative file (#2514 named
  `github-issue-workflow.md`; the decision log is `github-issue-workflow-wire.md`).
- The engine posts a marker whenever it writes `Acceptance`, so the thread shows the field history (the events API returns
  no field values).

## Requirements (planned)

| ID | Requirement | Phase |
|----|-------------|-------|
| PIPE-AAT-R-001 | No code path adds or removes an `AAT-*` label. `aat-pass`, `aat-fail`, `aat-inconclusive` post the comment and marker only; `aat-start` does not exist | P1 |
| PIPE-AAT-R-002 | No code path adds `in-prod`. Moving to Done still removes `busy` and closes the issue | P2 |
| PIPE-AAT-R-003 | Auto-skip lists every changed file of every merged PR linked to the issue and fails closed on any error, overflow or empty list | P3 |
| PIPE-AAT-R-004 | An auto-skip waive carries `source=paths`, binds to one sha, and is reset by a newer merge that is not eligible. A human `Skipped` keeps PIPE-AAT-D-007 | P3 |
| PIPE-AAT-R-005 | No auto-skip when any changed path is sensitive or outside `aat.autoSkip.globs`, or when `Acceptance` has any value, including a stale `Passed` or `Failed` from an older sha (those take the existing `aat.reset` row first, which sets `Pending` and so runs AAT); `aat.autoSkip` is absent or `enabled: false` by default | P3 |
| PIPE-AAT-R-006 | An auto-skipped non-follow-up still gets the non-gating intent-review doorbell | P3 |
| PIPE-AAT-R-007 | `aat-launch` records the launched agent; the verdict template names the real run | P4 |
| PIPE-AAT-R-008 | Every engine write to `Acceptance` is accompanied by a marker comment | P4 |

## Decisions (proposed)

Rows to append to the wire doc's decision log on agreement.

| ID | Decision | Status |
|----|----------|--------|
| PIPE-AAT-D-015 | The `Acceptance` field is the only acceptance state. The `AAT-progress`, `AAT-passed`, `AAT-failed` labels are retired; the `v2:aat` marker stays the verdict record | Proposed |
| PIPE-AAT-D-016 | `in-prod` is retired on v2 issues. Done plus close is the signal; the engine and legacy handler stop adding the label | **Accepted** (P2, PR #2701) |
| PIPE-AAT-D-017 | AAT is skipped per merge when every merged PR's changed files match `aat.autoSkip.globs` and none is sensitive; any read failure runs AAT. A human `Skipped` is unchanged (PIPE-AAT-D-007) | **Accepted** (P3, PR #2703) |
| PIPE-AAT-D-018 | Auto-skipped issues get the non-gating intent-review doorbell. Amends PIPE-AAT-D-005 | **Accepted** (P3, PR #2703) |
| PIPE-AAT-D-019 | `aat-launch` names the launched agent; every engine `Acceptance` write posts a marker | Proposed |

## Phases and implementation

Each phase is one PR to `main` (one outcome, per `atomic-pr-policy.md`). P1, P2 and P4 are independent of each other and can
start once Q1 or Q2 is answered. P3 needs the owner's Q3 and Q4 answers and the fail-marker census attached to its PR.

### P1. Retire the AAT labels

| Area | Change |
|------|--------|
| `scripts/lib/github_issue_workflow_aat.js` | Remove `AAT_LABELS` and `aatLabelPlan`. Keep the marker helpers and `validateMergeSha` |
| `scripts/github_issue_workflow.js` | Drop the `aat-start` case, the `AAT-*` entries in the ensure-labels list (line 36), and the label step in the `aat-pass/fail/inconclusive` cases (line 77 onward). Keep the `aat-pass` / `aat-fail` / `aat-inconclusive` names: the acceptance launch prompt (`scripts/issue_pipeline_v2_launch.js:266`) tells the agent to call exactly those, and it never mentions `aat-start`, so the prompt needs no change. `aat-start` is referenced only by the skill and `github_issue_workflow.js` |
| Tests | `scripts/github_issue_workflow.test.js` (label plan cases at 42–54, DELETE at 146): replace with "no label calls" assertions; one case that the marker line is unchanged |
| Skill | `.cursor/skills/agent-acceptance/SKILL.md` Phase 0 (remove the claim step), Phase 6 and Rules (label sentences), Quick reference. Follow `docs/agent-efficiency/agent-instructions.md` before editing an instruction file |
| Docs | `github-labels.md` §Agent acceptance; behaviour doc §Labels (v2) rows for `AAT-*` and §Agent acceptance item 2; `docs/e2e/pipeline-soak-catalog.md` and `plans/issue-pipeline-automation.md` mentions. Historic `changes/` logs stay as they are |
| After merge (ops) | Optionally delete the three labels from the repo. Existing labels on past issues are harmless history; deleting them is metadata only and the owner's call |

Verification: `node --test scripts/github_issue_workflow.test.js scripts/issue_pipeline_v2_acceptance.test.js`, then
`./scripts/pre-push-changed.sh`.

### P2. Retire `in-prod` (**delivered**, PR #2701)

| Area | Change |
|------|--------|
| `scripts/issue_pipeline_v2_apply.js` (`set-stage` → Done, lines 433–436) | Keep `deleteBusyLabel()` and the close; drop the `POST /labels in-prod` and the `labels:in-prod` applied entry |
| `.github/scripts/issue-agent-handlers.js:648` | `setLabels(..., [], ['busy'], …)`: stop adding `in-prod`, keep the `busy` removal. This file is under `.github/**`, a sensitive path: the PR needs explicit owner sign-off |
| Tests | `scripts/issue_pipeline_v2_apply.test.js:330` (asserts the label body) and the matching handler test |
| Docs | Behaviour doc §Labels (v2) and the Done row (line 77: "→ Done, issue closed, `in-prod` added"); `github-labels.md`; plan doc mentions |

### P3. Risk-tiered AAT (after Q3 and Q4)

| Area | Change |
|------|--------|
| `.github/pipeline-agents.json` | `aat.autoSkip: { "enabled": false, "globs": [...] }`. Config change is a sensitive path; ships disabled, the owner flips it after a dry-run soak |
| `scripts/issue_pipeline_v2_config.js` | Validate the new block (booleans, non-empty string globs, none matching a protected glob). Existing `aat` checks are at lines 136–145 |
| Facts | New `delivery.changedPaths` and `delivery.changedPathsError`, loaded in the runner next to `mergedPrNumbers` (`scripts/issue_pipeline_v2_release.js:174`) using `listPullFiles` from `scripts/lib/execute_plan_github.js` (already paginated and overflow-aware). Load only when `aat.autoSkip.enabled` and the issue is at In Main, so other stages pay no API cost |
| Decide | In `acceptanceInMain` (`scripts/issue_pipeline_v2_acceptance.js`): **`aat.autoskip-reset` first** when the newest `source=paths` waive is for an older sha and the new merge is not eligible (field → Pending, run AAT). Then the existing **`aat.reset`** row (lines 234–259) for stale `Passed`/`Failed`/`Manual`. Then **`aat.autoskip`** when the field is unset and paths are eligible → `aat-waive` with `source=paths` plus field `Skipped`. **Then** change the existing human **`skipped` waive row** (line 225): run only when `value === 'skipped'`, no `source=paths` waive binds for this sha, and the skip is human (PIPE-AAT-D-007). A later eligible re-merge while the field still reads `Skipped` is handled by `aat.autoskip` posting a fresh `source=paths` waive for the new sha — not the untyped row. Before **`aat.launch`**. `deriveAatState` and `waiveBinds` carry `source` so human `Skipped` and `source=paths` never share the untyped waive path |
| Eligibility helper | New pure function in `scripts/lib/` using `globToRegExp` (`scripts/lib/execute_plan_schema.js`) and `isForbiddenPath`; no network |
| Apply | `aat-waive` currently only comments because a human set the field. Add a field write for the auto case, and keep the sha-binding rules |
| Intent doorbell | In `decideInMain` (`scripts/issue_pipeline_v2_decide.js`), change `if (aatGateOn(...)) return acceptanceInMain(...)` so it does not return when a `source=paths` waive is bound for `delivery.lastMergeSha`. The existing `main.intent-request`, `main.intent` retry and `main.uat` rows then run unchanged. Pin the ordering with a `decide` test: auto-skipped → intent request → intent pending → In UAT. Amends PIPE-AAT-D-005 |
| Tests | Table tests for eligibility (each include glob, each never-skip glob, mixed PRs, empty list, overflow, API error → fail closed); an `acceptance` test that a human `Skipped` still persists and an auto waive resets on an ineligible newer merge; a prod-gate test that an auto-skipped merge is satisfied |
| Rollout | `enabled: false` → dry-run tick over beta issues and log would-skip decisions → enable. Same pattern as `AAT_GATE` (PIPE-AAT-D-012) |

### P4. Audit hygiene

| Area | Change |
|------|--------|
| `buildAatLaunch` and `apply.js` `launch-aat` | Add `agent=<id>` to the marker; `deriveAatState` reads it (ignore when absent, for old comments) |
| Skill and template | "Run:" field; Phase 3 internal-tooling clause |
| Spec DoR | Doc-path existence check in the spec-agent skill |
| Engine writes | A short `v2:aat-state` marker comment per `Acceptance` write |

## Risks

| Risk | Mitigation |
|------|------------|
| A path-only rule skips a change that matters (e.g. an engine bug in `scripts/`) | Narrow default globs; ships disabled; dry-run soak; intent doorbell stays; owner can force AAT with `Pending` |
| Removing labels loses a human cue | The board and issue sidebar show the field; no workflow reads the labels today |
| Files API cost or rate limit at In Main | Loaded only at In Main and only when enabled; at most one paginated call per merged PR per tick; fail closed rather than skip |
| `source=paths` waive and the human `Skipped` rule diverge in code | One shared `waiveBinds` with `source` as an explicit attribute and a test for each case |
| `.github/**` edits (P2, P3 config) | Sensitive-path rule: owner sign-off in the PR |

## Out of scope

- Whether Done should require the production frontend deploy (F7): separate issue against `promotion-contract.md`.
- Removing AAT altogether, or changing the In UAT → Done check.
- Changing fail reasons, `maxInconclusive`, timeouts or the `AAT_GATE` rollout.

## Open questions for the owner

1. Q1 to Q4 as above.
2. Is `PROD_PUBLIC_MODE` on in production? It decides whether the F7 frontend skip was intended.

Settled in review: auto-skip does not apply to follow-up issues. They already skip AAT and get intent review, so it would
add nothing.

## Next steps

1. Owner answers Q1 to Q4 on this PR.
2. Run the fail-marker census (`v2:aat verdict=fail` and `Acceptance=Failed`, by changed-path class) and attach it here.
3. Open one meta-issue for P1 to P4 (`Refs` from each phase PR), once Q1 to Q3 are answered.
4. Merge this PR as the agreed proposal vehicle, move the decisions to the wire decision log, then start P1.
