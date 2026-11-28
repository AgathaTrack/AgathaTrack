---
title: Autonomous PR Policy
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-28
tags: [agent-efficiency, policy]
---
# Autonomous PR policy (canonical)

Single source of truth for `/babysit`, `/babysit-plus`, and `/execute-plan`. Skills and commands **link here**; they do not restate full policy in different wording.

Whether an agent may merge is defined in [`AGENTS.md`](../../AGENTS.md) §Autonomy and merging; the babysit workflows below assume that gate is satisfied when the skill is active.

| Topic | Canonical location |
|-------|-------------------|
| Pre-PR self-review, review bots, Cursor model policy | [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) |
| One-outcome PRs + snag ladder | [atomic-pr-policy.md](./atomic-pr-policy.md) |
| Plan snapshot schema | [execute-plan-schema.md](./execute-plan-schema.md) |
| Phase exit profiles | [phase-exit-checklists.md](./phase-exit-checklists.md) |
| GitHub labels | [github-labels.md](./github-labels.md) |
| Lightweight PR loop | `.cursor/skills/babysit/SKILL.md` (cloud handoff: built-in `/autopilot`) |
| Babysit+ skill | `.cursor/skills/babysit-plus/SKILL.md` |
| Babysit-UAT skill | `.cursor/skills/babysit-uat/SKILL.md` |
| Execute-plan skill | `.cursor/skills/execute-plan/SKILL.md` |
| Runtime CLI | [execute-plan-runtime.md](./execute-plan-runtime.md) |

---

## Layering

| Entry | Role |
|-------|------|
| `/babysit` | Lightweight: sync, conflicts, comments, CI, push (skill; optional cloud handoff via `/autopilot`) |
| `/babysit-plus` | Autonomous PR operator: triage, fixes, debt issues, CI budget, **always merge** |
| `/babysit-uat` | Babysit+ through merge, then in-session pre-UAT watch — only on routes in §Driver routing rows 2, 4, 8b and 12 |
| `/execute-plan` (v1 schema-only plans) | Multi-phase orchestrator; babysit+ on phases, babysit-uat on final main merge. **v2:** `tick` and the driver own merge, pre-UAT and promotion; no babysit skill runs on plan PRs. |

Routing for any PR is in §Driver routing below. Other entry points may summarize it but must not contradict it. **Execute-plan v1 (historical):** intermediate phase PRs use **babysit-plus**; final PR to `main` uses **babysit-uat**. v2 uses row 1 only.

### Execute-plan (v2)

While a v2 worker or driver session is active, generic “stop and ask” rules are narrowed for in-scope
snapshot work; halt only on §Escalation or an unclear goal. Evidence goes to the control issue and PR
body, not routine user chat. See [execute-plan-v2.md](./plans/execute-plan-v2.md).

| Generic rule | During active v2 execute-plan |
|--------------|------------------------------|
| "Stop and ask human" (low confidence, minor policy conflict) | Proceed per snapshot; debt issue + continue; halt only on §Escalation or unclear goal |
| Multi-phase integration | Phase PRs target `integration_branch` from the v2 snapshot |
| `/execute-plan` without plan_id | Infer from conversation, branch, control issue, or single `busy` issue — skill §Resolve plan_id |

Skill: `.cursor/skills/execute-plan/SKILL.md` · **Instruction stack:** [execute-plan-instruction-stack.md](./execute-plan-instruction-stack.md)

#### Review threads on plan PRs

`tick` owns the review gate for plan PRs: any unresolved thread returns agent `triage-review` before the
driver arms or performs a merge (state-machine PR-ladder 5), PRs into `main` wait up to 15 min for Copilot
(PR-ladder 9), and the rulesets block merge while a thread is unresolved. The `triage-review` worker applies
§Review triage and §Debt issues to every listed thread, then replies on and resolves each one — an
unresolved thread relaunches the action. Copilot reviews only PRs into `main` (the release PR); phase PRs
into the integration branch carry human threads only.

---

## Babysit skill family

**Review conversations** = GitHub pull request **review threads** (`reviewThreads`). Rulesets on `main` and integration branches block merge while **any** review conversation is unresolved.

The **babysit skill family** is every agent entry that opens, updates, or merges a PR through a babysit workflow. **Procedure** (wait, triage every thread, reply and resolve each one, re-check after every push, `babysit_pr_reviews.js gate` before merge) is defined once in §Automatic reviews — skills link here; they do not duplicate those steps in different wording.

| Member | Resolve-all conversations |
|--------|---------------------------|
| `/babysit` | Yes — merge-ready = `gate` exit `0`; `/autopilot` handoff does not waive reply+resolve when you remain in session |
| `/babysit-plus` | Yes — §7 review gate; exit `2` → triage and resolve |
| `/babysit-uat` | Yes — babysit+ §0–7 on every merge, including remedial PRs |
| `/light-plan` phase and sync PRs | Yes — every one is driven by `/babysit-plus` (§7 `gate` exit `0` before merge); the release PR uses `/babysit-plus` (§Driver routing row 6) |
| Issue-pipeline delivery PR (`Method: PR`, or R1 scope in [issue-pipeline-babysit-gap.md](./plans/issue-pipeline-babysit-gap.md)) | Yes — driver per §Driver routing rows 10–11; delivery run keeps `busy` until the driver's gate passes |
| `/dependabot-batch` | Yes — Phase 3 babysit+ (wait, reply+resolve, `gate`) + Phase 5 `/babysit-uat` |
| `/execute-plan` workers (`triage-review`) | Yes — reply and resolve every listed conversation; `tick` relaunches while any stay unresolved |
| `/execute-plan` driver | Yes — `tick` PR-ladder 5 blocks on `unresolved_threads` (GraphQL; CCR route in Claude Code cloud sessions); ladder 9 waits for Copilot on young PRs to **`main` only**; driver arms auto-merge when the ladder passes (does **not** invoke `babysit_pr_reviews.js`; workers + ruleset enforce resolve-all) |
| `.cursor/rules/pr-hygiene.mdc` | Points agents at §Babysit skill family and §Automatic reviews |
| Claude **steward** skill | Same pointers for Claude-driven PRs |

**Doc drift guard:** `node scripts/check_babysit_skill_family.js` (pre-push and CI governance — see `_reusable-test.yml`).

**Driver.** A driver is the procedure in the linked skill file, plus the scripts that file names, followed by an agent in whatever session runs it. `disable-model-invocation: true` only stops the Skill tool from loading the file; it does not change which procedure counts as the driver. Unattended runs are told to read the skill file and follow it ([issue-pipeline-babysit-gap.md](./plans/issue-pipeline-babysit-gap.md) §1c).

### Driver routing

**Precedence.** The first matching row wins. `/babysit-uat` contains all of `/babysit-plus`; where a row says uat, uat is the driver.

| # | Case | Driver | Ends at |
|---|------|--------|---------|
| 1 | Active execute-plan v2 worker or driver on the PR (plan phase, sync, release or remedial) | `tick` and the driver, or the `triage-review` worker. **No babysit skill.** | Per [execute-plan-v2.md](./plans/execute-plan-v2.md) |
| 2 | Remedial PR from `/e2e-debug`, outside a v2 plan | `/babysit-uat` (mandatory) | Pre-UAT green on the merge SHA |
| 3 | `/dependabot-batch` CI phase | `/babysit-plus` | Squash merge |
| 4 | `/dependabot-batch` landing on `main` | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 5 | `/light-plan` phase or sync PR → integration | `/babysit-plus` (the light merge is the integration mechanic) | Squash merge, or merge commit for the release-conflict sync only |
| 6 | `/light-plan` release PR → `main` | `/babysit-plus` | Squash merge; pre-UAT runs async in Actions |
| 7 | Sprint agent PR → `cursor/sprint-*-integration-*` | `/babysit-plus` | Squash merge into integration |
| 8 | Sprint integration PR → `main`, no flagged shard | `/babysit-plus` | Squash merge; pre-UAT runs async |
| 8b | Sprint integration PR → `main`, touches a shard flagged by `babysit_uat_shard_risk.mjs` | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 9 | Narrow CI-only or docs-only PR to `main`, `## Docs` states pre-UAT `N/A — <reason>` | `/babysit-plus` | Squash merge |
| 10 | Pipeline delivery (`Method: PR`) → integration base | `/babysit-plus` | Squash merge |
| 11 | Pipeline delivery → `main` | `/babysit-plus` | Squash merge; pre-UAT runs async |
| 12 | User invokes `/babysit-uat` on a PR | `/babysit-uat` | Pre-UAT green on the merge SHA |
| 13 | User invokes `/babysit-plus` on a PR | `/babysit-plus` | Squash merge |
| 14 | User invokes `/babysit`, or asks for merge-ready only | `/babysit` | Gate exit `0`, no merge |
| 15 | Agent PR, no invocation, no programme | **None. The user merges** ([`AGENTS.md`](../../AGENTS.md) §Autonomy and merging) | — |
| — | Any base not listed above, for a programme or pipeline PR | `/babysit-plus`; comment the unexpected base on the issue | Squash merge |

`/babysit-uat` is the driver for rows 2, 4, 8b and 12 only. Plan remedials are owned by row 1 (`tick`), not row 2. Row 2 covers standalone `/e2e-debug` remedials.

**Execute-plan v1 (historical).** Not in the table above: intermediate phase PRs → `/babysit-plus`; final programme PR to `main` → `/babysit-uat`. Skills mark these "v1 only". v2 supersedes them with row 1.

### Issue-pipeline delivery PRs

Driver per §Driver routing rows 10–11. Plain `/babysit` is not a driver for agent PRs.

**Busy watchdog.** After long silence on a `busy` issue, `scripts/issue_busy_watchdog.js` comments on the issue. It does not merge anything. Non-light-plan issues are told to resume the owning PR with `/babysit-plus`, or to clear `busy` and record the state on the issue if the run is abandoned. Pipeline and programme drivers still follow §Driver routing rows 10–11 when the agent resumes. Light-plan issues point at `continue light-plan`.

---

## Proactive base sync

Detect when `main` (or the PR base branch) has moved; do **not** rebase the whole fleet on every poll.

| When | Command |
|------|---------|
| Start of babysit / babysit-plus | `./scripts/babysit_sync_base.sh --pr <url> --check` |
| Before every push, CI wait, long review poll (§0–§5) | `--check` only — see **§0–§5 `--push` exceptions** below |
| Immediately before merge (§7) | After `--claim`: one authoritative `./scripts/babysit_sync_base.sh --pr <url> --push` when action `rebase` (§Merge coordination) |

Script: `scripts/babysit_sync_base.sh` — fetches `origin/<base>`, rebases when behind, optional `--push` with `--force-with-lease`. Use `--pr <url>` so the rebase uses the PR's base, not always `main`. A head ref matching `cursor/*-integration-*` is not rebased and is not caught up to `main` because it is behind ([merge-policy](../../.cursor/rules/merge-policy.mdc)).

**Rebase-once-at-merge (babysit+):** During triage and CI fix loops (§0–§5), run `--check` only when the base moved — exit `1` (behind) alone is **not** a `--push` trigger. Defer the **authoritative** catch-up rebase to §7 (§Merge coordination, under `merge-lease`).

**§0–§5 `--push` exceptions** (still never on `cursor/*-integration-*` heads):

1. Sync cannot proceed without rebasing (rebase/merge conflict while resolving the PR branch onto the base).
2. Required CI is red and the failure is **attributable to being behind** the base — not an unrelated failure under §CI retry budget.

When another PR holds `merge-lease`, do **not** `--push` in §0–§5; wait (preflight exit `2`).

---

## Merge coordination

Serialize merge attempts when multiple PRs reach the CI gate at the same time. Does not eliminate all rebases; reduces thundering-herd rebase + CI churn.

**Evaluation order (preflight library):** `merge-lease` and FIFO **before** `behind_base`. A PR that is behind its base **while another PR holds the lease** exits `2` (wait) — **not** `1` (rebase). Rebases while blocked on a lease are what cause every waiter to hit exit `1` together after a merge and restart full CI in parallel.

**Lease covers rebase + CI + merge:** Always run `--claim` first at §7. When behind and no waiter ahead, `--claim` adds `merge-lease` and may still exit `1` — the holder rebases once, waits for CI, runs the review gate, and merges **without** `--release` until squash succeeds. Other PRs stay on exit `2` until the holder releases.

| When | Command |
|------|---------|
| Before merge (babysit+ §7) | `./scripts/babysit_merge_preflight.sh --pr <url> --claim` |
| `--claim` exit `0` | Up to date on the base; proceed to review gate and merge |
| `--claim` exit `1` (`behind_base` or `integration_mergeability_unknown`) | Lease held — `./scripts/babysit_sync_base.sh --pr <url> --push` once when action is `rebase` (not on an integration head); re-run CI if checks re-trigger; then review gate and merge. Do **not** release the lease between rebase and green required CI + merge except when required CI fails (next row). `recheck_mergeable`: refresh `mergeable`; do not rebase an integration head. |
| Required CI red while this PR holds `merge-lease` (after §7 rebase or while merging) | `./scripts/babysit_merge_preflight.sh --pr <url> --release`; fix in babysit+ §5; `--claim` again when required CI is green |
| Preflight exit `2` (wait) | Another PR holds `merge-lease` or FIFO yield — subscribe (`cursor-subscriptions` → `subscribe_github_pr` on lease holder or `subscribe_github_ci` on base) and wait; not a halt — **do not rebase** |
| Preflight exit `4` (integration conflict) | One PR that merges the base into the integration head and resolves the conflict. Do not rebase. |
| After successful merge | `./scripts/babysit_merge_preflight.sh --pr <url> --release` (no-op if PR closed) |
| Stale lease (≥45 min default, holder idle) | `--claim --force` — default should stay **longer than a full CI run** under the lease; tune `MERGE_PREFLIGHT_LEASE_STALE_MINUTES` if merges routinely exceed 45 min |

Script: `scripts/babysit_merge_preflight.sh` — `merge-lease` label mutex + FIFO yield when base was updated within 10 minutes and a lower-numbered green PR exists on the same base. After `--claim` POST, the script re-lists open PRs on the base; if multiple carry `merge-lease`, the **lowest PR number keeps the label** and others release theirs (exit `2`). `isPrCiGreen` accepts native `gh` rollup (`status` + `conclusion`) and GraphQL/shim `state`. Env: `MERGE_PREFLIGHT_BASE_HOT_MINUTES`, `MERGE_PREFLIGHT_LEASE_STALE_MINUTES`. Claim and release add or remove that label with the REST issue-labels API (`POST` / `DELETE /repos/{owner}/{repo}/issues/{n}/labels`). That path is this checkout. A pull or issue URL for a different repository is rejected (exit 3) before any label change. Release succeeds when the label is already absent, including after the PR is closed. Do not switch the mutation back to `gh pr edit`: that command fetches org team `login`, `name`, and `slug` (and Projects fields) before it edits, and a `repo`-only token fails the fetch. The script would then exit `3`, which babysit treats as a halt, on a preflight that had already evaluated clear.

## CI cost (Actions minutes)

Linux runner usage scales with **open PR count**, **pushes per PR**, and **jobs per `ci.yml` run**. Copilot review is a separate meter — see [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md).

| Practice | Why |
|----------|-----|
| **≤4 open `cursor/**` PRs** with full CI at once | Limits parallel matrix fan-out across branches |
| **Programme integration branch** (`cursor/*-integration-*`) | One CI-heavy line; single release PR to `main` |
| **Merge-lease (§Merge coordination)** | Reduces thundering-herd rebase + duplicate CI on the same base |
| **Babysit+ push batching** | `.cursor/skills/babysit-plus/SKILL.md` §5 — one push per logical fix batch |
| **§Driver routing** | One table for which skill owns each PR — most `main` landings use plus; pre-UAT async unless rows 2, 4, 8b or 12 |

See [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) § GitHub Actions minutes.

**§0–§5 sync:** `--check` at preflight and before push; `--push` only per §Proactive base sync exceptions (not on `cursor/*-integration-*`). **§7:** `--claim` → one `--push` rebase if needed (skip on an integration head) → required CI green (release lease if red) → review `gate` → `gh pr merge` → `--release`. A `MERGEABLE` integration release squash-merges while `BEHIND`.

---

## Pre-PR critical self-review (mandatory — all PR work)

Applies to **every** agent session and human-driven agent use **before** the first push that opens a PR and before any behavior-changing PR update. Not limited to `/babysit-plus`.

Checklist: [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) §Pre-PR critical self-review. Always-on rule: `.cursor/rules/pr-hygiene.mdc`.

Only after self-review passes: commit, push, create/update PR. Then continue with babysit workflow below.

---

## Automatic reviews (mandatory wait, triage and gate)

Applies to `/babysit`, `/babysit-plus` and `/babysit-uat`. Execute-plan v2 plan PRs: §Execute-plan (v2) review threads.

**Primary reviewer:** GitHub **Copilot** PR review (`copilot-pull-request-reviewer`) when enabled — **must be triaged when it posts review threads**. The `main` ruleset requests Copilot once when the PR opens (drafts included, not on later pushes); it posts 2–7 minutes later. Both the `main` and integration rulesets require every review thread to be **resolved** before merge.

**Agent-authored PRs to `main`:** the ruleset requests Copilot as the bot author, which has no licence, so
`pr-review-request.yml` requests Copilot with the owner's token and falls back to a review-only Cursor agent when
Copilot does not start (threads marked `cursor-pr-review`, reported as `reviewers.cursor` / reviewer `cursor`) —
[pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) §Agent-authored PRs.

**Model (Cursor):** [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) §Cloud Agent model policy.

`scripts/babysit_pr_reviews.js` (REST + review-thread GraphQL; works with the `repo`-scoped bot token). In Claude Code cloud sessions, where GraphQL is blocked, it and `babysit_sync_base.sh` run unchanged through `scripts/ccr-bin/gh`. That wrapper serves the same thread data from REST and the CCR review-thread route and fails closed. Same exit codes, same gate. Mechanics are in the Claude `babysit` wrapper (`.claude/skills/babysit/SKILL.md` §Babysit scripts).

| Command | Use | Exit |
|---------|-----|------|
| `wait --pr <url>` | Before triage — polls until no Copilot or Cursor-fallback review is in progress (a PR younger than 3 min counts as awaiting the Copilot request) | `0` ready · `3` a review still pending at the timeout (default 15 min; 25 min while the Cursor fallback is pending) — threads listed are triageable · `1` error |
| `gate --pr <url>` | Merge gate — `wait`, then require no unresolved threads (`mergeReady`) | `0` merge-ready · `2` unresolved threads → triage · `3` a review still pending at the timeout, nothing unresolved · `1` error |
| `collect --pr <url>` | One snapshot (no waiting) | `0` · `1` error |

Every review-thread page is read. A fetch or GraphQL error exits `1` and is never “no threads”: fix the error (identity, network) before continuing.

1. Mark PR **ready for review** before merge gates (`gh pr ready <url>` when draft).
2. **Wait, then triage** — `wait --pr <url>`; triage **every** unresolved thread in the JSON `threads` array (Copilot, Cursor, human) per §Review triage. Never declare “no automated review” while Copilot or the Cursor fallback is pending (`reviewers.copilot.state` / `reviewers.cursor.state == "pending"`) or threads exist.
3. **Close every thread** — reply on the thread (fixed in `<sha>` / false positive because … / deferred to #issue) and resolve it. Unresolved threads block merge (ruleset) and the merge gate.
4. **After every push** — run `wait` again and triage any new threads before entering or continuing the CI wait loop (human or re-requested Copilot reviews arrive at any time).
5. **Before merge** — `gate --pr <url>` must exit `0` as the last step before `gh pr merge`, after any sync push (§Merge gates → Execution). Exit `2` → back to triage.
6. **Copilot unavailable** — `wait` / `gate` exit `3`: comment `Copilot review did not finish within 15 min; proceeding on triage + CI + pre-push.` once; triage the listed threads; `gate` exit `3` (nothing unresolved) then counts as passing. Copilot absent (never requested, no credits): proceed. A Cursor fallback that is unavailable or still pending at the timeout (`cursorUnavailable`) is handled the same way. See [pr-review-cost-efficiency.md](./pr-review-cost-efficiency.md) §Copilot unavailable.
7. **Cursor Bugbot:** Retired — the script ignores it; never wait on it.
8. **Autofix:** Off by policy — babysit+ owns fixes (no duplicate Cloud Agent spend).

---

## Review triage

Run `node scripts/babysit_pr_reviews.js wait --pr <url>` and triage **every** unresolved thread in the output before applying fixes.

Post a **triage comment** on the PR before applying fixes. After acting on each thread, reply with the outcome and resolve it (§Automatic reviews step 3).

| Bucket | Signals | Action |
|--------|---------|--------|
| **Must-fix** | `request changes`, failing tests, bugs, security, migration risk, `blocker` / `critical` / `high` / `must` | Fix in this PR |
| **Nits** | `nit`, `minor`, `optional`, style-only in touched files | Fix if local + low-risk |
| **Ignore** | scope creep, future ideas, wrong reviewer read | Do not code; track in issue |

**Never ignore** blocker / critical / high / must signals.

**During active execute-plan** (`gate` exit `0`): prefer **debt issue + continue** unless must-fix vs merge-safety is genuinely ambiguous; halt with `**Needs you:**` on the **control issue** + short chat alert — not permission-seeking chat. **Otherwise:** low confidence → decide and record (PR comment or debt issue); ask only per `AGENTS.md` §When to ask.

**In-scope valid feedback stays in the PR.** Out-of-scope deferrals become issues (see §Debt issues). Aligns with `testing.mdc`.

### Nit heuristics

Apply when all true: same files as PR diff (or allowed exception), no API/behavior change, reviewer not wrong, matches repo rules.

Skip nit → debt issue when: auth/security paths, conflicts with conventions, needs product/architecture decision.

---

## Debt issues

Every **ignore** and every **skipped nit** must be tracked via **create or update** (never silent deferral).

### Dedupe key

```
sha256(plan_id + pr_number + file_path + normalized_concern)
```

`normalized_concern` = lowercase, collapsed whitespace, first 120 chars of reviewer text.

### Algorithm

1. Search: `label:review-follow-up label:tech-debt "<plan_id>"` + file path in body
2. Match on dedupe key → comment on existing issue
3. No match → `gh issue create` with labels `tech-debt`, `review-follow-up`, `plan:<id>`
4. Record issue # in `phase.debt_issue_refs`

### Batching

≥ **3** trivial nits, same reviewer, same PR, same file → **one** batched issue: `[tech-debt] Nits in <file> (PR #N)`.

**Never batch** blocker / critical / high / must items.

### Failure

If create and update both fail → `status: blocked`, `status_reason: issue_create_failed`.

---

## CI retry budget

Canonical rules for **red pushes on the PR head branch** before merge. Skills link here — do not restate numeric budgets elsewhere.

### Definitions

| Term | Meaning |
|------|---------|
| **Red push** | A push whose `CI` workflow run for the PR concludes **failure** (`cancelled` does not count). |
| **Streak** | Consecutive red pushes on one PR head branch; resets on the first green `CI` run. |
| **Same signature** | The same failing required **job name**, or for Playwright the same test id (`file:line › title`). |

### Limits

| Condition | Action |
|-----------|--------|
| Streak **2** with a Playwright failure | Before the next push, reproduce locally on `localhost:3000` (`./scripts/pre-push-changed.sh --e2e-specs …`, `--project=full` as CI). Record classification per `.cursor/agent-kernel/protocols/e2e.md` §1 in the PR. |
| Streak **3** on the **same signature**, or streak **5** on **any** signature | **Halt** pushing. One summary comment (failing tests, classification, hypotheses tried). Hand off: `/e2e-debug` for E2E; otherwise `**Needs you:**`. |
| `ci-loop` label on the PR (when `ci-loop-detector` is deployed) | `./scripts/pre-push-changed.sh` exits **4** unless `--ci-loop-override "<reason>"` (distinct from exit `3` on `babysit_pr_reviews.js`). |

Mechanical labelling (non-blocking workflow) is specified in `docs/agent-efficiency/plans/ci-pass-rate-improvement.md` §S2.

### Pre-UAT remedial (separate counter)

After merge to `main`, **pre-UAT remedial rounds** are capped by `/babysit-uat` (max **3** full `babysit-uat` loops per original feature PR). That budget does not share the PR-head red-push streak counter above.

Then halt. Never weaken CI gates to pass.

---

## Merge (always auto)

Babysit+ and execute-plan **always squash-merge** when merge gates pass. There is no `manual` or `labeled` mode.

### Halting before merge

Do **not** merge when: `do-not-merge` label, control issue `autonomous-revoked`, or PR is `draft` (when merge intended).

### Merge gates (before agent merge)

- CI green on PR
- Required approvals present
- Review gate: `node scripts/babysit_pr_reviews.js gate --pr <url>` exits `0` (no Copilot review in progress, every thread triaged and resolved; `3` after the Copilot-unavailable comment) — the last check before `gh pr merge`
- Not draft; no `do-not-merge`
- `./scripts/pre-push.sh` green locally
- BDD gate unchanged or intentionally updated
- File size gate respected
- Dual-backend parity when routes touched
- `approved_until` not past; not revoked
- **Documentation:** behaviour-changing PRs pass the docs gate (`## Docs`, canonical doc sync or `N/A — reason`) per `.cursor/skills/canonical-docs/SKILL.md` and babysit+ §Exit checklist

### Execution

Run merge coordination first (§Merge coordination):

```bash
./scripts/babysit_merge_preflight.sh --pr <url> --claim
# Exit 2 → wait (do not rebase). Exit 1 after --claim → lease held; rebase once below, then merge without releasing until squash succeeds.
# Integration head (`cursor/*-integration-*`): do not --push; MERGEABLE while BEHIND is OK. Exit 4 → merge base into release.
./scripts/babysit_sync_base.sh --pr <url> --push    # when action rebase and head is not an integration release; skip if up to date
# Required CI red while holding merge-lease → --release, §5 fixes, --claim when green (§Merge coordination)
node scripts/babysit_pr_reviews.js gate --pr <url>  # must exit 0 — after the last push; 2 → release the lease, back to triage
gh pr merge <url> --squash
./scripts/babysit_merge_preflight.sh --pr <url> --release
gh pr view <url> --json state,mergedAt,mergeCommit
```

Verify merge commit is ancestor of `origin/<base_branch>` before next phase.

---

## Post-merge pre-UAT

**CI always runs** `pre-uat-e2e.yml` on every merge to `main`. Most programme and pipeline PRs use `/babysit-plus` only (§Driver routing rows 6, 8, 11): the agent session ends at squash merge; pre-UAT is asynchronous.

**In-session pre-UAT watch** (`/babysit-uat`) applies only on §Driver routing rows 2, 4, 8b and 12. See `.cursor/skills/babysit-uat/SKILL.md`.

**CI owns promotion** after pre-UAT green: `pre-uat-e2e.yml` → `promote-uat.yml` →
`deploy-uat.yml` → `prod-ready`. Neither babysit+ nor babysit-uat polls deploy.

After merge to `main` when `/babysit-uat` is the driver:

1. Record merge SHA.
2. Watch `pre-uat-e2e.yml` for **that merge SHA**; remedial loop per `.cursor/skills/babysit-uat/SKILL.md`.
3. **Do not poll** `deploy-uat.yml` or prod-ready from the main session.

A red pre-UAT on an async path is handled outside the delivery session (for example a standalone `/e2e-debug` run). See [babysit-routing-reconciliation.md](./changes/babysit-routing-reconciliation.md) §8 C1.

See `docs/e2e/uat-deploy-tiers.md` · `docs/pipelines/ci-cd-gates.md` §3 · `docs/e2e/uat-promote-manual.md`.

**Infra-only blockers** (e.g. `UAT_AUTO_MIGRATE` unset with pending live migrations) → comment on PR/control issue and escalate; do not weaken gates.

---

## Issue hygiene (autonomous runs)

| When | Control issue | User chat (execute-plan) |
|------|---------------|--------------------------|
| Create issue and **start work immediately** | `node scripts/github_issue_workflow.js start-work --issue <n> --body "…"` (comment + `busy`) | — |
| Create debt issue for **later** | Comment on PR with issue # only | — |
| Progress / milestone | Comment on the issue | None — control issue only (gate `0`) |
| Pause or question for human | `**Needs you:**`; halt/pause when blocked on human | Short alert: issue link + unblock action (halt-class only) |
| Plan or task complete | Close with summary (`complete-plan --write` for control issues) | Brief completion note **only after** `complete-plan` |

**Project board status** (the Project `Status` field) is **not** updated by Cloud Agents — GitHub does not grant Projects write on agent tokens. Use comments + `busy`. The org field `Stage` is governed by the who-writes-what table in [github-issue-workflow-behaviour.md §Who writes what](./github-issue-workflow-behaviour.md#who-writes-what), the `/analyse-issue` intake is an engine row (**PIPE-V2-D-ANALYSE-003**, revised 2026-11-26), so agents write no `Stage`.

---

## Halt and resume

### Revoke = halt only

Does **not** close PRs, delete branches, or revert merged commits.

Does stop new commits, merge attempts, and new phases.

**Revoke:** add `autonomous-revoked` on control issue; optional `do-not-merge` on open PRs.

**Expiry:** past `approved_until` (default 48h from approval) → treat as `halted` / `revoked`. Re-approve after reviewing plan size and blockers.

### Graceful shutdown

1. Finish safe atomic step only
2. Do not merge if revoke detected pre-merge
3. Update live plan: `autonomy: halted`, `next_action`, `artifact_ref`, `pr_head_sha`
4. Comment on control issue + open PRs
5. Push plan artifact to phase branch
6. Stop agent

### Resume

1. Remove `autonomous-revoked`; comment `resume-plan <plan_id>`
2. `/execute-plan <plan_id> resume`
3. Revalidate: snapshot hash, not expired, not revoked
4. `gh pr view` → `headRefOid` == `phase.pr_head_sha` else `resume_mismatch` (human `accept-head` to override)
5. Continue from `next_action`; do not redo `merged` phases

Plan changes after approval → new snapshot + `approve-autonomous` again. v2: plans are immutable after approval; changing the plan's goal means a new plan. A fix outside the approved scope that the plan needs in order to land is not a scope change: land it as a plan-linked side PR (runbooks §7.5); time and budgets are renewed with `resume-autonomous`.

---

## Escalation (always stop)

- Security / crypto
- Breaking API without version bump
- Production data migrations
- CI workflow gate changes
- Product / legal decisions
- Drift (`status_reason: drift`)
- CI budget exhausted
- Issue tracking failed

(UAT prod-ready failure uses **pause** + sub-agent remedial + **auto-resume** — not escalation. True halt only for infra blockers per babysit-plus §9.)

---

## Approval

| Keyword | Action |
|---------|--------|
| `approve-autonomous <plan_id>` | Grant upfront autonomy; freeze snapshot; start phase 1 |
| `resume-plan <plan_id>` | Continue after halt |
| `accept-head` | On control issue — acknowledge PR force-push; update `pr_head_sha` |

`approved_until` = `approved_at + 48 hours` (mandatory).
