---
name: babysit
description: Lightweight AgathaTrack PR loop — sync base, conflicts, review threads, CI, push until merge-ready. For Cursor cloud PR handoff use built-in /autopilot first; use this skill for in-repo scripts and policy.
disable-model-invocation: true
---

# Babysit PR (lightweight)

Your job is to get this PR to a **merge-ready** state (do not merge unless the user explicitly asks).

## Cursor cloud handoff

When the user wants a **background cloud agent** on the PR (monitor feedback, CI, conflicts remotely), run built-in **`/autopilot`** on that PR, then continue with AgathaTrack checks below in this repo when you remain in session. **`/autopilot` does not waive resolve-all review conversations** — still run `wait`, reply+resolve every thread, and `gate` before merge-ready (autonomous-pr-policy §Babysit skill family).

For **in-session** babysitting (scripts, Router, pre-push), follow the steps below.

**Model:** **`composer-2.5` only** — switch before starting if needed. See `docs/agent-efficiency/pr-review-cost-efficiency.md`.

**Pre-PR review:** If the PR is not open yet, complete mandatory pre-PR critical self-review first (`.cursor/rules/pr-hygiene.mdc`). Run the **Engineering Router** (`.cursor/agent-kernel/ROUTER.md`, profile per skill). Run **`/canonical-docs sync`** when the diff changes behaviour (`.cursor/skills/canonical-docs/SKILL.md`). If the diff touches Flutter presentation UI, apply **`.cursor/agent-kernel/protocols/accessibility.md` §Quick pass** before opening the PR.

Check PR status, comments, and latest CI and resolve any issues until the PR is ready to merge.

1. **Sync (check-first):** Detect when the branch is behind the base **without rebasing on every poll**:
   ```bash
   ./scripts/babysit_sync_base.sh --pr <url> --check
   ```
   Exit `1` (behind) alone is not a `--push` trigger — see autonomous-pr-policy §Proactive base sync (`--check` only; narrow §0–§5 exceptions). Do not `--push` on `cursor/*-integration-*`. For babysit+ merge and `merge-lease`, see §Merge coordination.
2. **Merge conflicts:** Intelligently resolve, preserving intent of both sides. If intents conflict, stop and ask.
3. **Ready for review:** If the PR is still a draft, mark it ready (`gh pr ready <url>`).
4. **Wait for reviews:** `node scripts/babysit_pr_reviews.js wait --pr <url>` — returns once no Copilot or Cursor-fallback review is in progress (Copilot posts 2–7 min after open; agent-authored PRs get the Cursor fallback when Copilot does not start); triage **every** unresolved thread in the JSON output (Copilot, Cursor, humans). A script error is never “no threads”. Exit `3` (a review still pending at the timeout) → autonomous-pr-policy §Automatic reviews step 6.
5. **Comments:** Apply triage buckets (autonomous-pr-policy §Review triage) to every thread. Validate findings — fix valid issues; explain false positives. Then reply on and **resolve** each thread — rulesets block merge while any is unresolved. Do not re-run full adversarial review in agent turns (slim babysit).
6. **CI:** Fix failures caused by this PR's scope. Never weaken CI gates to pass. If failure seems unrelated, `--check` first; `--push` when behind only if the red CI is attributable to being behind (policy §0–§5 exceptions) — except an integration head.
7. **Verify locally:** `./scripts/pre-push-changed.sh` for scoped fix; `./scripts/pre-push.sh` before final push when near merge.
8. **Push** scoped fixes, then repeat step 4 (new threads) and re-watch CI. Run `./scripts/babysit_sync_base.sh --pr <url> --check` before each push; `--push` only per policy §0–§5 exceptions (not merely behind); never on an integration branch.
9. **Merge-ready** only when CI is green **and** `node scripts/babysit_pr_reviews.js gate --pr <url>` exits `0` after the last push (exit `2` → back to step 5; `3` → step 4's Copilot-unavailable rule).

**After merge to `main`:** CI runs Pre-UAT E2E and promotion automatically — babysit+ does not spawn agents or poll deploy (babysit-plus §8).

**Heavier workflows:** `/babysit-plus` (default driver for programme/pipeline `main` PRs) · `/babysit-uat` (rows 2, 4, 8b, 12 only — in-session pre-UAT) — see `docs/agent-efficiency/autonomous-pr-policy.md` §Driver routing.

Escalate to human when: security/crypto changes, breaking API contracts, migration risk, or product/legal decisions.

Full policy: `docs/agent-efficiency/pr-review-cost-efficiency.md` · `docs/agent-efficiency/autonomous-pr-policy.md`
