---
title: Pr Review Cost Efficiency
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-16
tags: [agent-efficiency, policy, actions-cost]
---
# PR review & cost efficiency

**Homes:** pre-PR self-review · Copilot + Cursor Bugbot fallback · **Cloud Agent model policy** · Actions cost levers.

| Topic | Also see |
|-------|----------|
| Babysit+ workflow | `.cursor/skills/babysit-plus/SKILL.md` |
| Triage / merge gates | [autonomous-pr-policy.md](./autonomous-pr-policy.md) |
| Always-on rule | `.cursor/rules/pr-hygiene.mdc` |

**Cursor Bugbot (fallback):** Secondary reviewer when Copilot PR review was **absent** on a PR that **merged to `main`**. Workflow `cursor-review-fallback.yml` runs on `pull_request` **closed** (merged) and queues Bugbot via `POST /bugbot/review`. Effort **low** (`.cursor/config/bugbot.yaml`). Pre-merge babysit still waits on Copilot (and any existing Cursor threads); merge-time Bugbot is for audit and follow-up on closed PRs. Disable with env `CURSOR_REVIEW_FALLBACK=off`.

**Operator:** Enable Bugbot for this repository in **Cursor → Automations → Bugbot** and set repository **`manualTriggerOnly: true`** so only the workflow (or a human `cursor review` comment) queues reviews — not duplicate auto-on-every-push. Actions secret `cursor_api_key` must allow Bugbot review API.

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

Cursor Bugbot (Copilot absent on main) → triage when threads exist

Babysit+ (composer-2.5 for babysit steps — see below)
  → babysit_pr_reviews.js wait --pr <url>   (Copilot or Cursor fallback done → triage every thread)
  → fix + pre-push-changed.sh → reply + resolve threads → push → wait again → CI
  → babysit_pr_reviews.js gate --pr <url>   (exit 0) → pre-push.sh → merge
```

When Copilot is absent before merge: self-review + CI + review gate; after merge to `main`, the fallback workflow may queue Cursor Bugbot on the closed PR (§Automatic review fallback). Full procedure: autonomous-pr-policy §Automatic reviews.

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
| Copilot once per PR (ruleset) + Bugbot only when absent | Automatic review off agent pool except guarded fallback |
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
| AEC-D-004 | Cursor Bugbot fallback on **merge to `main`** when Copilot was absent (`cursor-review-fallback.yml`, `effort: low`); `babysit_pr_reviews.js` triages Cursor threads when present | Live |

---

## Automatic review fallback (Copilot absent)

Applies to PRs targeting **`main`** only (matches Copilot ruleset scope).

1. **Pre-merge** — babysit waits on Copilot (three-minute grace after open). Triage any Copilot or human threads before merge.
2. **On merge to `main`** — when the PR **closes merged** and Copilot is still absent, `cursor-review-fallback.yml` runs `scripts/cursor_review_fallback.js` (no grace sleep) and queues **Cursor Bugbot** on the closed PR URL.
3. **Post-merge threads** — if Bugbot posts on the closed PR, triage and resolve or open follow-up issues; they do not block the merge that already landed.
4. **Manual** — comment `cursor review` on an open PR pre-merge when you want Bugbot before merge.
5. **Timeout** — `wait` / `gate` exit `3` when Copilot or Cursor is still pending at timeout but nothing unresolved — optional PR comment once; see §Copilot unavailable legacy note below.
6. **Kill switch** — `CURSOR_REVIEW_FALLBACK=off` (Actions env or local) restores Copilot-only behaviour.

Do not manually `POST` Copilot reviewers without org credits.

### Copilot unavailable (legacy escape hatch)

When **both** reviewers fail to finish within the wait timeout and there are no threads: self-review + CI + `./scripts/pre-push.sh` before merge; `gate --pr` exit `3` with nothing unresolved counts as passing.

---

## Related

[autonomous-pr-policy.md](./autonomous-pr-policy.md) · [atomic-pr-policy.md](./atomic-pr-policy.md)
