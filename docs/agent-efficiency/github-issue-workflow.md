---
title: GitHub issue workflow
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [documentation, github-issues, automation]
---
# GitHub issue workflow

This document describes how issues are filed, triaged, and moved through delivery for Agatha Track.

**Issue pipeline v2** (`ISSUE_PIPELINE_V2`): the org issue field **`Stage`** is the engine’s authoritative state; an engine moves issues through eight stages. The Pawpet project **Status** column is separate (humans drag cards; release jobs may still update **Status**). There is no automatic two-way sync between **Status** and **`Stage`** ([#2345](https://github.com/AgathaTrack/AgathaTrack/issues/2345)). Behaviour, wire contract, and operations are split under [§Pipeline v2](#pipeline-v2-the-stage-machine). Plan of record: [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). Legacy label-flow workflows (`agent-dispatch`, `agent-monitor`, `triage-human-reviewed`) and the v1 dispatcher were removed in run D ([#2411](https://github.com/AgathaTrack/AgathaTrack/issues/2411)); superseded plan docs were deleted from the tree (git history retains them).

## Issue forms

Issue intake uses GitHub Issue Forms in [`.github/ISSUE_TEMPLATE/`](/.github/ISSUE_TEMPLATE/). Blank issues are disabled; contributors must choose a form.

| Form | File | Purpose |
|------|------|---------|
| Bug | `bug.yml` | Report incorrect or broken behavior with reproduction steps and environment details. |
| Feature | `feature.yml` | Request a new capability or enhancement with problem statement and acceptance criteria. |
| Task | `task.yml` | Track internal engineering or maintenance work with scope and definition of done. |

New issues from these forms receive type labels (`bug`, `feature`, or `task`) and `needs-triage`.

**Legacy issues:** Issues created before these forms were introduced are not automatically normalized. They may need manual enrichment to match the fields expected by triage and future automation.

## Planned workflows by status

Lane behaviour is defined in [§Pipeline v2](#pipeline-v2-the-stage-machine) and the v2 tick (`issue-pipeline-v2.yml`). Release and merge handlers in [§Cursor agent execution layer](#cursor-agent-execution-layer) still run for issues the engine does not own.

## Pipeline v2: the Stage machine

An issue moves through eight stages by agent work alone, except where a human is needed. The only state is stored on the
issue; everything else (votes, linked PRs, Definition of Done progress, run liveness, deployments) is read from GitHub on
every tick. Plan of record: [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385). Code: `scripts/issue_pipeline_v2*.js`
(a pure `decide(facts, config)` plus thin readers and one action executor). Runner-cap **`queued`** retries use the same
`ring-doorbell` path for spec, review, intent review, and blocked wake (pickup clock and `busy` rules: PIPE-V2-D-TICK-004 in
[wire contract](./github-issue-workflow-wire.md#decision-log)).

### Pipeline v2 split (read by purpose)

| Document | Purpose |
|----------|---------|
| [github-issue-workflow-behaviour.md](./github-issue-workflow-behaviour.md) | **Behaviour** — stored state, who writes what (under `on` only the engine writes `Stage`, including the `/analyse-issue` Backlog → To do intake), transitions, holds, delivery contract, launch and intent review, blocked reasons, labels, agent acceptance, prod guard |
| [github-issue-workflow-wire.md](./github-issue-workflow-wire.md) | **Wire contract** — review rounds, markers (`v2:*`), hashes, nonces, attempts, decision log (PIPE-* IDs, soak4 outcomes) |
| [github-issue-workflow-operations.md](./github-issue-workflow-operations.md) | **Operations** — switch reference (#2560), dry-run/preview, migration, soak playbook, board setup, and the **`/analyse-issue` mission** (`mission=analyse`, engine intake, §Analyse mission; folded from the former `changes/analyse-issue-skill.md`) |

### Delivery contract

Delivery agents (`PR`, `light-plan`, `execute-plan`) must follow the rules in [§Delivery contract](./github-issue-workflow-behaviour.md#delivery-contract) (`busy`, `Refs #n`, Definition of Done ticks, `finish-work` / `Blocked`). Light-plan and pipeline **Stage** ownership are spelled out there.

### Decision log

Authoritative **PIPE-*** and **PIPE-V2-*** rows (Accepted soak outcomes through soak4, REV3, holds, analyse-issue, #2560) live in [§Decision log](./github-issue-workflow-wire.md#decision-log). Change proposals under `changes/` fold accepted rows into that table.

Run D removed legacy dispatch workflows and retired superseded plan docs ([#2411](https://github.com/AgathaTrack/AgathaTrack/issues/2411)); **PIPE-V2-D-DISPATCH-001** is updated in the wire decision log.


## Cursor agent execution layer

GitHub remains the source of truth. The v2 engine (`issue-pipeline-v2.yml`) decides when to ring doorbells and launch Cursor or Claude workers; there is no label-driven `agent-dispatch` workflow after run D ([#2411](https://github.com/AgathaTrack/AgathaTrack/issues/2411)). Release automation (merge → UAT → prod) still uses the handlers below for issues the engine does not own.

### Components

| File | Purpose |
|------|---------|
| [`.github/workflows/issue-pipeline-v2.yml`](/.github/workflows/issue-pipeline-v2.yml) | Scheduled and manual pipeline v2 tick |
| [`.github/workflows/issue-agent-pr-merge.yml`](/.github/workflows/issue-agent-pr-merge.yml) | On merged `cursor/**` PR → **In Main**, record expected UAT tag |
| [`.github/workflows/promote-uat.yml`](/.github/workflows/promote-uat.yml) | On push to `main` → create `uat-YYMMDD-PR#` tag |
| [`.github/workflows/deploy-uat.yml`](/.github/workflows/deploy-uat.yml) | UAT deploy + **Notify linked agent issue** job → **In UAT** or escalate |
| `execute-plan-scope.yml` (forbidden paths on all PRs to `main`) | Required commit status; owner review clears forbidden hits ([#1980](https://github.com/AgathaTrack/AgathaTrack/issues/1980)) |
| [`.github/scripts/agent-payload-lib.js`](/.github/scripts/agent-payload-lib.js) | Sanitized task payload + prompt |
| [`.github/scripts/agent-safety-lib.js`](/.github/scripts/agent-safety-lib.js) | Preflight + forbidden path rules (`agent-approved` / `human-reviewed` checks for launches) |
| [`.github/scripts/launch-cursor-agent.js`](/.github/scripts/launch-cursor-agent.js) | Calls Cursor Cloud Agents API v1 | <!-- pragma: allowlist secret -->
| [`.github/scripts/issue-agent-handlers.js`](/.github/scripts/issue-agent-handlers.js) | Merge + UAT / prod **Stage** transitions |

### Delivery launches (v2)

Ready issues with capacity receive a `v2:launch` doorbell from the engine. `launch-cursor-agent.js` runs the preflight in `agent-safety-lib.js`, builds a payload with `agent-payload-lib.js`, and records run metadata on the issue. Agents must run `./scripts/pre-push-changed.sh` and open a PR with `Refs #<n>` (**not** `Fixes`/`Closes`) on success.


### Safety boundaries

Encoded in the sanitized prompt **and** enforced in CI:

**Forbidden paths** (agent PR safety gate fails the PR):

- `db/migrations/**`
- `server/config/security.js`
- `infra/**`
- Any path matching `/auth/`, `/billing/`, or `/secrets?/` (e.g. `server/routes/auth/`)

**Allowed for agent PRs** (with gate hygiene): `.github/workflows/**` — update `docs/pipelines/ci-cd-gates.md` and `scripts/ci/assert-*-gate.sh` in the same PR when adding or renaming blocking jobs.

**Forbidden actions** (documented in prompt):

- Push directly to `main`
- Bypass PRs
- Access or log secrets
- Modify auth, billing, or permissions code
- Weaken CI gates to pass

Issues with `manual-only` are not auto-launched; the engine respects the same blocking labels at decision time.

### Branch and PR conventions

- Agent branches: `cursor/issue-<n>-<slug>-7a9a` (Cursor may auto-generate `cursor/...`; prompt requests this pattern)
- PRs: against `main`, body must include `Refs #<n>` (keeps the issue open; merge handler reopens if GitHub auto-closed it)

### Merge → UAT automation

When an agent PR merges to `main`:

1. **[merge handler](/.github/workflows/issue-agent-pr-merge.yml)** parses `Refs #<n>` / `Fixes #<n>` from the PR body, removes `busy`, **reopens** the issue, sets the org `Stage` field to **In Main**, and posts the expected UAT tag (`uat-YYMMDD-PR#`).
2. **[promote-uat.yml](/.github/workflows/promote-uat.yml)** runs on the `main` push, resolves the merged PR, and creates the `uat-YYMMDD-PR#` tag on the merge commit.
3. Tag push triggers **[deploy-uat.yml](/.github/workflows/deploy-uat.yml)** automatically.

When UAT deploy finishes, the **Notify linked agent issue** job in `deploy-uat.yml` sets the org `Stage` field to **In UAT** (or adds `question` on failure). Prod notify walks the Pawpet board but **selects candidates by org `Stage` = In UAT** (not the project `Status` column), then sets `Stage` to **Done** and closes the issue.

An **execute-plan control issue** is not a UAT ticket (title starts with `execute-plan`, including `[execute-plan]`). The merge handler reopens it after an accidental `Closes` at release merge but does **not** set **In Main** or post the UAT-tracking comment; UAT notify skips it. **Light-plan** tracking issues (`light-plan:` title) are UAT-tracked like product issues: release PR `Refs #n`, session ends at Pre-UAT green without closing; merge handler sets **In Main**; UAT notify sets **In UAT**; prod notify sets **Done** and closes (ISSUE-PIPELINE-D-002).

Manual UAT rerun: **Actions → Deploy UAT (uat.agathatrack.com) → Run workflow** with `deploy_ref` = your UAT tag (e.g. `uat-260709-122`).
- UAT promotion tag: `uat-YYMMDD-PR#` (created automatically on merge to `main`)

### Required secrets

| Secret | Purpose |
|--------|---------|
| `cursor_api_key` | Cursor User API Key (**github-actions-pawpet-automation** in Cursor dashboard) |
| `GH_PROJECTS_PAT` | Project GraphQL updates (UAT deploy is tag-triggered; no `workflow_dispatch` needed) |
| `GH_PROJECT_ID` | GitHub Project v2 node ID |
| `GH_STATUS_FIELD_ID` | Status field node ID |

Optional:

| Variable / secret | Default |
|-------------------|---------|
| `CURSOR_AGENT_MODEL` | Optional override for legacy launch workflows; when unset, launch scripts use the implementation model id from [pr-review-cost-efficiency.md §Cloud Agent model policy](./pr-review-cost-efficiency.md#cloud-agent-model-policy) (never the dashboard default) |
| `AGENT_ASSIGNEE` | `KanopeeKa` |

#### Cursor API key setup

This repository uses a **dedicated User API Key** (non-Enterprise plans do not expose separate service accounts):

1. Cursor dashboard → **API** → create key named `github-actions-pawpet-automation`.
2. GitHub → repo → **Settings → Secrets and variables → Actions** → repository secret `cursor_api_key`.
3. Verify repo access: `curl -H "Authorization: Bearer $KEY" https://api.cursor.com/v1/repositories`

#### Project IDs (org Project Pawpet)

```bash
GH_PROJECTS_PAT=ghp_... node .github/scripts/discover-project-ids.js --org AgathaTrack
```

Pick the **Pawpet** project from the script output (not **ATSupport**). Legacy user-owned boards used `--user <login>`.

### Monitoring and debugging

- **Weekly dependabot batch:** Actions → **Dependabot batch dispatch** (Tuesday cron; `workflow_dispatch` with `dry_run` for payload-only). Agent URL is written to the workflow job summary. Dispatched agents receive **`/run-as-me`** in the launch prompt (owner `gh` for merge and cleanup).
- **Pipeline v2 tick:** Actions → **Issue pipeline v2**; each run logs one summary line per tick (`scripts/issue_pipeline_v2.js`).
- **Issue comment markers:** `v2:launch` doorbells and `<!-- cursor-agent-run: {...} -->` on legacy paths store run ids
- **Cursor UI:** follow the agent URL on the doorbell comment
- **Dry run:** set `ISSUE_PIPELINE_V2=dry-run` or use workflow `workflow_dispatch` dry-run inputs

### UAT CD notes

Current UAT deploy (`deploy-uat.yml`) is FTP-based. When `UAT_SSH_ENABLED=true`, SSH deploy can restart the backend and run migrations (`UAT_AUTO_MIGRATE=true` for automatic `migrate.js up`). **`promote-uat.yml`** creates `uat-*` tags on merge to `main`; the **Notify linked agent issue** job sets **In UAT** when all UAT gates pass.

#### CloudLinux `node_modules` (cPanel Node.js Selector)

UAT backend dependencies are **not** shipped over FTP. CloudLinux stores packages under `~/nodevenv/...` and expects **`backend/node_modules` to be a symlink** it creates when you click **Run NPM Install** in **Setup Node.js App**.

| Do | Don't |
|----|-------|
| Deploy `package.json` + `package-lock.json` via FTP | Upload or keep a real `backend/node_modules/` folder on the server |
| Run **Run NPM Install** in cPanel after `package.json` changes | Run plain `npm install` in SSH outside the CloudLinux venv |
| Delete a stale real `backend/node_modules` once, then use cPanel npm | Assume destroying/recreating the Node app removes FTP files |

The deploy workflow strips any local `server/node_modules` before FTP and excludes `node_modules` from the upload. **FTP does not delete** an existing remote folder — a leftover real `node_modules` from an older SSH/cPanel install must be removed manually once.

**Forbidden on UAT (see `docs/pipelines/uat-backend-node-modules-runbook.md`):**

| Do not | Why |
|--------|-----|
| `npm ci` / `npm install` in `backend/` without nodevenv | Creates real `node_modules/` |
| Delete or FTP-overwrite `backend/.htaccess` | Breaks Passenger |
| Upload `node_modules/` via FTP | Breaks CloudLinux symlink |

**CI invariant (requires `UAT_SSH_ENABLED=true`):** `scripts/ci/assert-node-modules-symlink.sh` runs pre/post restart; deploy fails on exit `10` (missing), `11` (real dir), `12` (broken symlink). Manual `workflow_dispatch` deploys **fail** when SSH is disabled unless `allow_unverified_deploy=true` (emergency bypass). Push deploys warn in the Actions summary when SSH is off.

Deploy summary includes `ssh_invariant_enforced` (policy), `ssh_invariant` (execution), and `deploy_verification=verified|unverified` (derived). Emergency bypass: `allow_unverified_deploy` — see `docs/pipelines/uat-backend-node-modules-runbook.md`.

**Verify backend after deploy:**

```bash
curl -sk -w "\nHTTP %{http_code}\n" "https://uat.agathatrack.com/backend/health"
# expect: {"status":"OK"} and HTTP 200
```

**Apache SPA routing:** `flutter_app/web/.htaccess` excludes `/backend` from the Flutter `index.html` fallback so API routes reach Passenger. CI stages a non-dot copy as `htaccess.spa` because FTP deploy may omit dotfiles; the UAT SSH step renames it to `.htaccess` at the domain root. **Never delete** cPanel-generated `backend/.htaccess` (Passenger) — backend FTP excludes `**/.htaccess`.

**UAT SSH and migrations (Phase 5):** when `UAT_SSH_ENABLED=true`, the SSH deploy
bundle restarts the backend and records deploy proofs before HTTP smoke. Set
`UAT_AUTO_MIGRATE=true` to run `node scripts/migrate.js up` over SSH (mirrors prod).
FTP-only deploys still require cPanel **Run NPM Install** and manual SQL when SSH
or auto-migrate is off. **In UAT** is set only after all `deploy-uat.yml` gates pass
(`smoke`, live `@smoke` E2E, full localhost E2E, and `prod-ready`).

**Production promotion:** `deploy-prod.yml` runs automatically after green UAT
**`Prod ready`** (stub `vX.Y.Z-rc.N` tag when `PROD_DEPLOY_ENABLED` is not `true`;
full FTP + SSH deploy when `true`). Manual **`workflow_dispatch`** remains available
for overrides. See [promotion-contract.md](../pipelines/promotion-contract.md).


## Execute-plan v2 driver

**Operating instructions:** [execute-plan-runtime.md](./execute-plan-runtime.md) (CLI, `tick`, tokens). **Snapshot fields (v1):** [execute-plan-schema.md](./execute-plan-schema.md). **Programme / work packages** (build history, not routine ops): [plans/execute-plan-v2.md](./plans/execute-plan-v2.md).

Two workflows run execute-plan v2 without a long-lived agent session. Both are thin: they check out `main`, run
one script under `.github/scripts/`, and the logic lives in `scripts/lib/execute_plan_*.js`. Platform design record:
[work-packages-platform.md](./plans/execute-plan-v2/work-packages-platform.md) §WP7b.

| Workflow | Events | Does |
|----------|--------|------|
| [`execute-plan-approve.yml`](/.github/workflows/execute-plan-approve.yml) | `issue_comment` (created, edited, deleted) by the repo owner **or** `pawpet-bot` on `approve-autonomous` only | Validates `approve-autonomous` / `resume-autonomous` / `revoke-autonomous` on a control issue, creates the integration branch, status comment and labels on approve, then dispatches `execute-plan-driver.yml` for the plan (passes never run inline, so they share the driver's concurrency group). Pipeline programmes (`source_issue` on the snapshot): `pawpet-bot` may post `approve-autonomous`; `scripts/lib/execute_plan_pipeline_approve.js` enforces D-001 policy; failure → `needs-owner` on the product issue and `autonomous-revoked` on the control issue |
| [`execute-plan-driver.yml`](/.github/workflows/execute-plan-driver.yml) | `pull_request_target` (not fork PRs; a secret-less relay job re-dispatches the driver on `main`), `workflow_run` (CI, Pre-UAT, Promote UAT, Deploy UAT), `issues` labels, 30-minute heartbeat, manual dispatch | Runs `tick` for each affected active plan and executes the one driver action it returns |

**Control comments** (one line, on the control issue, by an owner in `.github/execute-plan.config.json`):
`approve-autonomous <plan> sha256:<hash> until <ISO>`, `resume-autonomous <plan> sha256:<hash> until <ISO>`
(renews time and budgets, at most 14 days), `revoke-autonomous <plan>`. Contracts: `execute-plan-v2/contracts.md` §3.3.
An invalid approve gets one reply `approve-autonomous rejected: <reason>`; other invalid comments are ignored.
Editing or deleting an approve or resume comment stops the plan on the next pass (`approval-invalid`).

**Kill switch:** repository variable `EXECUTE_PLAN_DRIVER` — `off` (default when unset or unknown: nothing runs),
`dry-run` (validate and decide, write only the job summary), `on`. Checked first in both scripts.

**Environment and secrets**

Jobs that read automation secrets use GitHub Environment **`automation`** (deployment branches: `main` only). Repository-level copies may exist during migration; environment secrets take precedence once configured.

| Secret / variable | Location |
|-------------------|----------|
| `EXECUTE_PLAN_BOT_TOKEN`, `cursor_api_key` / `CURSOR_API_KEY`, `GH_PROJECTS_PAT`, `GH_PROJECT_ID`, `GH_STATUS_FIELD_ID`, `PAWPET_CLAUDE_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (Claude doorbell workflow only) | `automation` environment |
| `E2E_BYPASS_TOKEN` | `UAT` environment |
| Deploy SSH keys and prod/UAT deploy secrets | `UAT` / `PROD` environments |
| `POSTHOG_*`, PR CI build secrets | repository (unchanged) |

**Tokens**

| Operation | Token |
|-----------|-------|
| Reads, `workflow_dispatch` (Pre-UAT, Deploy UAT), the `execute-plan-scope` commit status | `GITHUB_TOKEN` |
| Branches, sync/release PRs, `update-branch`, auto-merge, labels, comments, status comment | `EXECUTE_PLAN_BOT_TOKEN` (from `automation`) |
| Cursor API (worker launch) | `cursor_api_key` (from `automation`) |
| Plan workers | the bot token, passed by the driver at launch (`envVars`: `GH_TOKEN`, `EXECUTE_PLAN_TOKEN`); a worker `tick` refuses to run unless its token is `bot_login` |

**Identity:** invite `pawpet-bot` on every repo Cursor uses and add it to your GitHub Project. Cursor dashboard:
**`GH_TOKEN`** = bot PAT (default); **`OWNER_GH_TOKEN`** = your PAT for **`/runasme`** only (`.cursor/skills/run-as-me/SKILL.md`).
Issue/dispatch launches pass **`EXECUTE_PLAN_BOT_TOKEN`** as Cursor `envVars`. See runbooks §7.1 and
`docs/engineering/cursor-cloud-environment.md`.

Per-plan serialization comes from the single `execute-plan-driver` concurrency group plus the lease in the status
comment; the driver never waits inside a job. One action per plan per pass; the next event or heartbeat continues.

## Smoke-test log

| Date | Issue | Note |
|------|-------|------|
| 2026-07-09 | #122 | UAT delivery path smoke test — documentation-only change validating triage → Cursor agent → PR → merge to `main` → `uat-YYMMDD-PR#` tag → UAT deploy (legacy path used `release/uat-*` branches). |
