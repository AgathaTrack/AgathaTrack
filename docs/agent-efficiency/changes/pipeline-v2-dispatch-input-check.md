---
title: Pipeline v2 dispatch-input visibility check (pipeline-claude-run)
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, review, security]
---

# `pipeline-claude-run.yml`: dispatch inputs and log exposure

Read-only review for **PIPE-V2-D-REV3-011** (promise-then-reveal). No workflow was dispatched for this document.

## Workflow inputs

| Input | Required | Used where |
|-------|----------|------------|
| `issue` | yes | Prepare step env `INPUT_ISSUE` → `pipeline_claude_prepare.js` → `PIPELINE_ISSUE` via `GITHUB_ENV` |
| `stage` | yes | Prepare: `INPUT_STAGE` → `PIPELINE_STAGE` |
| `agent_id` | yes | Prepare: `INPUT_AGENT_ID` → agent resolve + `PIPELINE_AGENT_ID` |
| `method` | yes | Prepare: `INPUT_METHOD` (method when no stage task) |
| `nonce` | yes | **Not** passed as a step `env` value. Prepare reads `inputs.nonce` from `GITHUB_EVENT_PATH` (`readDispatchNonce()`), masks it, then writes `PIPELINE_RUN_NONCE` to `GITHUB_ENV` for later steps only |
| `run_ref` | yes | Workflow `run-name:` (`pipeline-claude-${{ inputs.run_ref }}`). Not passed to prepare env; public identifier for status lookup |

## Prepare and Claude steps (nonce path)

1. **Dispatch** — engine sends `nonce` and `run_ref` in the `workflow_dispatch` payload (see `scripts/pipeline_runners/claude.js`).
2. **Prepare** (`pipeline_claude_prepare.js`, step “Prepare PIPELINE_* env and prompt”):
   - Reads nonce from event JSON, not from `inputs.nonce` in step env (workflow deliberately omits it).
   - First use of nonce in the job: `::add-mask::` (GitHub Actions masking).
   - Writes `PIPELINE_RUN_NONCE` to `GITHUB_ENV` for the Claude and verify steps.
3. **Run Claude Code** — `PIPELINE_RUN_NONCE` in job env (masked after prepare); verdict CLI reads it internally.
4. **Verify** (`pipeline_claude_verify.js`) — reads `PIPELINE_RUN_NONCE` from env; passes nonce to `runEvidence` for pattern match on issue comments only.

## Log-printing check

Steps that could expose the nonce in **public job logs**:

| Location | Prints nonce? | Notes |
|----------|---------------|--------|
| `.github/workflows/pipeline-claude-run.yml` `run-name` | **No** | Uses `run_ref` only |
| Prepare step env block | **No** | `nonce` is not listed under `env:` |
| `pipeline_claude_prepare.js:51` | **No** | `::add-mask::` — value is redacted in logs, not echoed in clear text |
| `pipeline_claude_prepare.js:80` | **No** | Warning text only (request comment read failure) |
| `pipeline_claude_prepare.js:97-99` | **No** | Stack on fatal error — nonce not in error path unless thrown with message (prepare does not embed nonce in thrown errors) |
| `pipeline_claude_verify.js:51-57` | **No** | Logs issue number and evidence kind only (`Claude run evidence on #N: …`) |
| `runEvidence` (`pipeline_claude_run_lib.js`) | **No** | Uses nonce in regex against comment bodies; does not log nonce |

**Conclusion (job logs):** No step is written to print the dispatch `nonce` in clear text. The prepare step masks it before other console output.

**Visibility of dispatch inputs on the public run page: NOT VERIFIED by Claude or Cursor. Requires a logged-out browser check of a pipeline-claude-run run page by the owner.**

## Owner checklist (logged-out browser)

Do this once on **main** (today’s runs may still use the nonce in the run **title**) and again after **REV3-011** merges (title should be `pipeline-claude-<run_ref>` only).

### A. Is the dispatch **`nonce` input** visible on the run page?

1. Open a **private/incognito** window (not signed in to GitHub). Optional: use a second browser profile with no GitHub cookies.
2. Navigate to: `https://github.com/AgathaTrack/AgathaTrack/actions/workflows/pipeline-claude-run.yml`
   - If GitHub shows a sign-in wall and hides workflow runs, the repo’s Actions visibility for anonymous users is already limited — note that and skip to section B.
3. In the run list, open a **completed** run (green check). Example URL shape: `https://github.com/AgathaTrack/AgathaTrack/actions/runs/<run-id>`.
4. On the run summary page, scroll to **“Workflow dispatch inputs”** (or **“Inputs”** / **“This workflow was manually triggered”** with a key–value list). GitHub often shows: `issue`, `stage`, `agent_id`, `method`, `nonce`, `run_ref` (after REV3-011).
5. Check the row for **`nonce`**. If you can read the full hex value without signing in, record **inputs visible: yes**. If the section is missing or values are hidden, record **inputs visible: no** or **inputs section absent**.
6. Add the result and run URL to this doc or a comment on PR **#2537**.

### B. Is the nonce exposed without opening inputs? (run title on current main)

1. Still logged out, on the same run page, read the **page title / h1** (top heading).
2. If it reads `pipeline-claude-<32-char-hex>` and matches a doorbell nonce, the nonce is **already public in the run name** on the workflow version on **main** (known pre–REV3-011 behaviour). After merge of `run_ref`, repeat: the title should **not** equal the nonce.

### C. What the API showed (Cursor, owner token)

- Authenticated REST **does not** return dispatch input values on the run object.
- **Public** fetch of run `45017702070` showed title `pipeline-claude-dfd96c2c1a68e396cfc13a6b83ce6da2` (nonce in name on main).

Until A is done, treat **inputs-panel** visibility as **unknown**.

## If the nonce input is visible on the public run page (owner options — not implemented)

### (a) Fetch nonce from a private channel the job can read

| Approach | Cost |
|----------|------|
| **Repository secret per run** (engine writes e.g. `PIPELINE_NONCE_<run_ref>` via API before dispatch, job reads by `run_ref`) | One secret write + delete per doorbell; secret namespace churn; 100-secret limits; rotation and cleanup automation |
| **Claude job environment from prepare** (nonce only in `GITHUB_ENV`, never in dispatch inputs — **current design intent**; dispatch would pass only `run_ref` and a lookup id) | Engine must store nonce server-side (DB, cache, or encrypted issue comment) until the job starts; more moving parts in the tick |
| **Encrypted payload in a private issue comment** visible only to `pawpet-claude` | Extra comment per launch; engine and prepare must agree on encoding |

### (b) Accept public nonce for Claude runs

If the dispatch input is public, any reader can copy `nonce` before the run posts its verdict. A same-login peer (`pawpet-claude` shared by `claude-a` and `claude-b`) could post a counterfeit `v2:verdict` naming that nonce within the launch window, weakening the promise-then-reveal guarantee. Mitigation would be to rely on first-reveal wins and timing, or return to option (a).