---
title: Pr Review Cost Efficiency
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-16
tags: [agent-efficiency, policy, actions-cost]
---
# PR review & cost efficiency

**Homes:** pre-PR self-review · Copilot triage · **Cloud Agent model policy** · Actions cost levers.

| Topic | Also see |
|-------|----------|
| Babysit+ workflow | `.cursor/skills/babysit-plus/SKILL.md` |
| Triage / merge gates | [autonomous-pr-policy.md](./autonomous-pr-policy.md) |
| Always-on rule | `.cursor/rules/pr-hygiene.mdc` |

**Cursor Bugbot:** Retired for this repo (user decision). Do not configure, wait on, or document active Bugbot flows.

---

## Pre-PR critical self-review (mandatory)

Before the first push that opens a PR and before any behavior-changing PR update:

1. **Correctness & impact** — Happy paths, edge cases, error handling, regressions.
2. **Risks** — Security, data integrity, migrations, API contracts, concurrency.
3. **Design quality** — Smallest change; match patterns; no drive-by refactors.
4. **Better solution** — Adopt clearer/safer approach now if equal or less scope.
5. **Documentation** — `/canonical-docs sync` when behaviour changes (`.cursor/rules/documentation.mdc`).
6. **Verification** — `./scripts/pre-push-changed.sh` after adjustments.

Then: commit → push → create or update the PR.

---

## Review stack

```
Implementation
  → pre-PR critical self-review (mandatory)
  → open PR / mark ready

Copilot PR review (when enabled) → triage when threads exist

Babysit+ (composer-2.5 for babysit steps — see below)
  → babysit_pr_reviews.js wait --pr <url>   (Copilot done → triage every thread)
  → fix + pre-push-changed.sh → reply + resolve threads → push → wait again → CI
  → babysit_pr_reviews.js gate --pr <url>   (exit 0) → pre-push.sh → merge
```

When Copilot is unavailable or posts no threads: proceed after self-review + CI green + review gate (§Copilot unavailable). Full procedure: autonomous-pr-policy §Automatic reviews.

---

## Agent-authored PRs (Copilot request + Cursor fallback)

The `copilot_code_review` ruleset requests Copilot **as the PR author**. Only the owner's personal account has a
Copilot licence, so PRs opened by `pawpet-bot` / `pawpet-claude` never get the automatic review. The org does not
buy a second licence.

`.github/workflows/pr-review-request.yml` (runner `scripts/pr_review_request.js`) handles these PRs:

| Step | Behaviour |
|------|-----------|
| Trigger | `pull_request_target` opened / ready_for_review / reopened → `main`, same-repo, non-draft, author `pawpet-bot` or `pawpet-claude`. A secret-less relay re-dispatches the job on `main` (the `automation` environment is main-only); PR code is never checked out. |
| 1. Request Copilot | With `OWNER_COPILOT_REQUEST_TOKEN` (owner fine-grained PAT, Pull requests: read and write). A Copilot request the ruleset already made (as the unlicensed author) is withdrawn and replaced, so Copilot reviews on the owner's licence. No owner token → straight to step 3. |
| 2. Wait | Up to 8 min for `copilot_work_started` (issue events) or a Copilot review. The last check runs after the deadline: a PR closed or a Copilot start in the final interval stops the run. |
| 3. Fallback | Withdraw the Copilot request and launch a **review-only** Cursor agent (`composer-2.5`, bot identity) from the PR head with `workOnCurrentBranch: false`, so any stray change lands on a new agent branch, not the PR. It posts one `COMMENT` review with inline findings marked `<!-- cursor-pr-review -->`, and must not edit, push, approve or request changes (prompt rule; the bot token itself can push). |
| State | One `github-actions[bot]` comment with a `<!-- pr-review-request: … -->` marker (`requested` → `copilot` / `cursor-launched` / `unavailable`). `cursor-launched` records `launched_at` and `reviewer_login`. Markers from other authors are ignored. |

Babysit: `babysit_pr_reviews.js` reports the fallback as `reviewers.cursor`, waits for it (up to
`--fallback-timeout-min`, default 25) and labels its threads `cursor`. Only marked reviews by `reviewer_login`
submitted after `launched_at` count, so a quoted marker never completes the fallback. Once the marker is
`cursor-launched` or `unavailable`, a leftover Copilot request counts as superseded, not pending. `unavailable`
(no Cursor key, launch failed) sets `cursorUnavailable` → `wait` / `gate` exit `3` (§Copilot unavailable). Cursor
threads are triaged like Copilot threads. Repository variable `PR_REVIEW_FALLBACK` defaults to `on`; set it to `off`
to disable the workflow. Human-authored PRs keep the ruleset path.

---

## Cloud Agent model policy

Usage data showed thinking models on babysit-scale work burn disproportionate tokens. **Babysitting stays on Composer 2.5.**

| Work | Model |
|------|--------|
| Feature implementation, refactors, execute-plan workers | `composer-2.5` default |
| Deep architecture / ambiguous product trade-offs | Thinking models **only when explicitly needed**; switch back after |
| `/babysit`, `/babysit-plus`, `/babysit-uat`, triage, CI loop, merge | **`composer-2.5` only** |

Controls: this section (SSOT), `.cursor/rules/pr-hygiene.mdc` pointer, dashboard default, separate cloud agent for babysit-only sessions. During execute-plan gate `0`, model mismatch alone is not a chat stop — autonomous-pr-policy §Execute-plan overrides.

---

## Cost levers (summary)

| Lever | Effect |
|-------|--------|
| Pre-PR self-review | Fewer fix iterations after open |
| `composer-2.5` for babysit | Avoid thinking-model burn on triage/CI |
| Copilot once per PR (dashboard) | Automatic review off agent pool |
| Push batching | Fewer `ci.yml` runs (`AGENTS.md` §Autonomy and merging) |
| Pre-UAT cancel superseded runs | Stale E2E grids stop when `main` advances |

---

## GitHub Actions minutes (Linux runners)

Copilot credits and Actions minutes are separate meters. Levers: batch pushes, integration programmes, merge-lease, ≤4 open `cursor/**` PRs with full CI — autonomous-pr-policy § CI cost.

### Decision log

| ID | Decision | Status |
|----|----------|--------|
| AEC-D-001 | Oct 2026 Actions spike mainly `ci.yml` volume, not Copilot runners | Live |
| AEC-D-002 | Trim triggers, push batching, Pre-UAT cancel-in-progress, PR E2E max 2 legs | Live |
| AEC-D-003 | Babysit skills wait for Copilot before triage, re-check reviews after every push and gate merge on `babysit_pr_reviews.js gate` (PR #2017 merged 1 s before Copilot's 3 threads; `collect` also failed under the `repo`-only bot token) | Live |
| AEC-D-004 | Agent-authored PRs: request Copilot with the owner's token, fall back to a review-only `composer-2.5` Cursor agent when Copilot does not start within 8 min (§Agent-authored PRs). Cursor Bugbot rejected (separate subscription, no review-only fallback trigger) | Live |
| AEC-D-005 | Claude Code cloud sessions (GraphQL blocked by the session proxy) run the babysit scripts unchanged through `scripts/ccr-bin/gh`. It answers the review-thread query from the CCR `review_threads` route joined to REST review comments; `gh pr view` base/head (sync-base); and merge-preflight snapshot reads (`gh repo view` nameWithOwner, snapshot `gh pr view`, `gh pr list`) from REST. It fails closed when any comment is unaccounted for. Chosen over porting the scripts so the review-gate logic stays single-path (owner, 2026-11-22) | Live |

---

## Copilot unavailable

1. Do not request Copilot reviewer without credits.
2. Self-review + CI + `./scripts/pre-push.sh` before merge to `main`.
3. `wait --pr` exits `3` (Copilot still pending at the timeout) or Copilot absent — triage any existing threads; `gate --pr` must exit `0`, or `3` with nothing unresolved, before merge.
4. Optional PR comment: Copilot unavailable; CI + pre-push only.

---

## Related

[autonomous-pr-policy.md](./autonomous-pr-policy.md) · [atomic-pr-policy.md](./atomic-pr-policy.md)
