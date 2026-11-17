---
name: agent-acceptance
description: Agent Acceptance Test (AAT) — holistic final review of an issue or its delivery PR against original intent, observable app behaviour, and shipped code. Sets AAT labels, posts the verdict on the issue, and routes small follow-up PRs or P0 sub-issues when acceptance fails. Invoke as /AgentAcceptance. Do not run on pipeline follow-up (sub-)issues.
disable-model-invocation: true
---

# Agent acceptance (`/AgentAcceptance`)

**Outcome:** One authoritative acceptance verdict on a **parent** issue (or the issue linked from a PR): intent and non-functional needs met, behaviour verified in the running app, and a last holistic code review — or a concrete remediation path.

**Not the same as** [intent-review-agent](../intent-review-agent/SKILL.md) (engine-triggered, In Main, findings only). AAT is **user-invoked**, **gates** closure via labels, and includes **hands-on behaviour checks**.

---

## Router

**Profile:** `full` — classify from the issue spec, merged PR diff(s), and paths touched.

1. Read `.cursor/agent-kernel/ROUTER.md`.
2. Load protocols implied by the change (security, accessibility, API contract, release verification when user journeys changed).
3. Map `verification[]` to local runs below plus manual UI checks.

**Model:** `composer-2.5` for orchestration; use `computerUse` for non-trivial UI surfaces.

---

## Eligibility

| Input | Resolve |
|-------|---------|
| Issue number | That issue |
| PR URL or number | Primary linked issue from `Refs #n` (prefer `Refs` over `Closes`). If several issues, use the one in the PR title or the highest parent (not a follow-up). If none, stop and ask for the issue number. |

**Sub-issues (forbidden):** If the issue body contains `<!-- v2:follow-up of=#… -->`, **stop**. Sub-issues are delivery work for a parent; run `/AgentAcceptance` on the **parent** after remediation closes.

**Author conflict:** If you authored the linked delivery PR(s), say so in a comment, remove `AAT-progress`, and stop — another agent should run AAT.

---

## Phase 0 — Claim and labels

```bash
node scripts/github_issue_workflow.js aat-start --issue <n>
```

This removes `AAT-passed` and `AAT-failed`, adds `AAT-progress`. Creates repo labels on first use if your token can; otherwise create them once in GitHub (**Settings → Labels**): `AAT-progress`, `AAT-passed`, `AAT-failed`.

Post a short comment: scope (issue + PRs), merge SHAs, and that AAT is in progress.

---

## Phase 1 — Recover intent and constraints

1. Read the **issue from creation**: summary, problem, acceptance criteria, Definition of Done, delivery plan, decision comments, and canonical doc links (`docs/domains/`, `docs/architecture/index.md`).
2. Separate **functional** intent (what users can do) from **non-functional** needs (a11y, performance expectations, security/privacy notes, copy tone, calendar-date rules, offline/error behaviour) stated or implied in the issue or canonical doc.
3. Note explicit **out of scope** — do not fail AAT for excluded work.

Do not treat the PR description as the source of intent.

---

## Phase 2 — Shipped code and linkage

1. List PRs merged to `main` linked to the issue (`gh issue view <n> --json timelineItems` or timeline in UI; `Refs|Fixes #n` in PR bodies).
2. Read each PR diff against `main` at the merge commit(s).
3. Confirm Definition of Done checklist items on the issue; call out any unchecked item that is actually done (tick it) or missing (remediation).

---

## Phase 3 — Behaviour in the app (mandatory for UI/API behaviour)

Prove the **resulting behaviour**, not only that tests pass.

1. **Environment:** `sudo pg_ctlcluster 16 main start`; migrations `cd server && node scripts/migrate.js up`; single-origin stack `cd server && PGUSER=user PGPASSWORD=password PGHOST=localhost PGPORT=5432 PGDATABASE=agatha_db node bin/start.js` → `http://localhost:3000/`.
2. **Exercise** the flows the issue describes — happy path and material edge cases (empty state, permission denied, validation error) when the issue or canonical doc implies them.
3. **Evidence:** Save screenshots or a short screen recording under `/opt/cursor/artifacts/` (see walkthrough-artifacts skill). Reference paths in the final issue comment.

Skip live UI only when the issue is strictly non-behavioural (docs-only, CI-only) and you prove that from the issue text — say so explicitly in the review.

---

## Phase 4 — Holistic view

Synthesize Phases 1–3:

- Does the delivered product match the **initial intent** and NFRs?
- Gaps the delivery plan missed but intent implied (callers, migrations, docs, failure-path tests)?
- Regression smell in adjacent areas you touched during verification?
- Docs: behaviour changes reflected in canonical docs (`/canonical-docs sync` rule applies to delivery agents; AAT checks readers will not be misled).

Escalation items in `AGENTS.md` §When to ask → **fail** AAT and set `Blocked=decision` on a follow-up or the parent per owner policy; do not “pass” security or product calls.

---

## Phase 5 — Last overall code review

One pass over the **merged** code (not open branches):

- Correctness, error handling, alignment with repo conventions.
- Security/authz/validation on new surfaces.
- Tests: meaningful coverage of new behaviour; no trivial-only tests for critical paths.
- PR hygiene debt: follow `docs/agent-efficiency/pr-review-cost-efficiency.md` mindset — **material** issues fail AAT; nits belong in a small follow-up PR if you still pass.

---

## Phase 6 — Verdict and labels

Post a single **final review comment** on the issue with this structure:

```markdown
## Agent Acceptance Test (AAT)

### Intent
…

### Behaviour verified
… (artifact links)

### Code review
…

### Verdict
**PASS** | **FAIL** — one sentence.

### Remediation (FAIL only)
…
```

### PASS

```bash
node scripts/github_issue_workflow.js aat-pass --issue <n> --body-file /path/to/comment.md
```

- Sets `AAT-passed`, clears `AAT-progress` and `AAT-failed`.
- **Closing:** Close the issue only when policy allows (e.g. legacy flow or owner asked; pipeline v2 **Done** is still engine-driven after UAT/prod — do not force-close an In Main / In UAT issue unless the owner invoked AAT as the explicit close gate). When close is allowed: `gh issue close <n> --comment "AAT passed."`

### FAIL

```bash
node scripts/github_issue_workflow.js aat-fail --issue <n> --body-file /path/to/comment.md
```

Sets `AAT-failed`, clears `AAT-progress` / `AAT-passed`.

Choose **one** remediation shape:

| Situation | Action |
|-----------|--------|
| **Small** — one PR can finish acceptance | Open a `cursor/**` PR with `Refs #<parent>` (never `Closes`). Mention it in the review comment. Re-run `/AgentAcceptance` on the parent after merge. |
| **Large** — multiple PRs or unclear scope | Open **one** sub-issue (task template) whose body **starts with** `<!-- v2:follow-up of=#<parent> -->`. Set **Priority** to `P0`. Leave `Stage` empty so pipeline v2 places it in **To do**. Title prefix: `[AAT]` … Link the sub-issue in the parent comment. **Do not** run AAT on the sub-issue. Subscribe until the sub-issue closes, then run `/AgentAcceptance` again on the parent (`cursor-subscriptions` → `subscribe_github_issue` or babysit wait policy). |

If a prior AAT-failed cycle left open remediation PRs or sub-issues, reconcile them in the new review before passing.

---

## Rules

- **Parent issues only** — no AAT on `v2:follow-up` issues.
- **Evidence on the issue** — the comment is the record; chat is not enough.
- **No drive-by fixes** during AAT except ticking an accurate DoD checkbox on the issue body when permitted.
- **Refs not Closes** on remediation PRs (pipeline v2 delivery contract).
- Re-entry: each AAT run starts with `aat-start` (clears prior pass/fail labels).

---

## Quick reference

| Command | Purpose |
|---------|---------|
| `node scripts/github_issue_workflow.js aat-start --issue <n>` | Begin AAT |
| `node scripts/github_issue_workflow.js aat-pass --issue <n> [--body \| --body-file]` | Pass + optional comment file |
| `node scripts/github_issue_workflow.js aat-fail --issue <n> [--body \| --body-file]` | Fail + optional comment file |
| `node scripts/github_issue_workflow.js comment --issue <n> --body "…"` | Mid-run notes |

Labels: `docs/agent-efficiency/github-labels.md` §Agent acceptance.