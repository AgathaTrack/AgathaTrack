---
title: Cursor Cloud environment
owner: Documentation Team
audience: agent
status: active
last_updated: 2026-11-18
tags: [agent, engineering, cursor, environment]
---

# Cursor Cloud environment

Cursor Cloud Agents only. Shared toolchain and commands: [`AGENTS.md`](../../AGENTS.md) §Toolchain.

## Repository URL (org)

Canonical GitHub slug: **`AgathaTrack/AgathaTrack`** (`https://github.com/AgathaTrack/AgathaTrack`).

- **Cursor → Cloud Agents → Environment:** set the linked repository to `AgathaTrack/AgathaTrack` (rebuild or refresh the environment after the org transfer).
- **Execute-plan / issue dispatch (Cursor API):** `repos: [{ url: "https://github.com/AgathaTrack/AgathaTrack", startingRef: "…" }]`.
- **GitHub Actions:** `GITHUB_REPOSITORY` is set automatically; scripts use it instead of hard-coding the slug.

## GitHub identity secrets (dashboard)

Configure under **Cursor → Cloud Agents → Secrets** (runtime secrets apply to all repos in the dashboard scope).

| Secret | Set to | Used when |
|--------|--------|-----------|
| **`GH_TOKEN`** | `pawpet-bot` classic PAT (`repo` only) | **Default** Cloud Agent `gh`/API identity (git pushes use the Cursor GitHub App) |
| **`OWNER_GH_TOKEN`** | Owner classic PAT (`repo` only; no `workflow`, `admin:*` or `delete_repo`; ≤ 90-day expiry) — runbooks §7.1 | User invokes **`/runasme`** — `.cursor/skills/run-as-me/SKILL.md` |
| **`BOT_GH_TOKEN`** | Optional; same as bot PAT | Not read by any code; prefer only **`GH_TOKEN`** for bot |

Agents launched by the execute-plan driver or by issue/dispatch workflows receive `OWNER_GH_TOKEN` and
`BOT_GH_TOKEN` blanked through launch `envVars`; owner mode (`/runasme`) is for interactive sessions only.

**Exception — dependabot batch:** `.github/workflows/dependabot-batch-dispatch.yml` launches agents with
`dependabotBatchLaunchEnvVars()` (bot PAT only; does not blank owner). The dispatch prompt opts into `/run-as-me`;
`OWNER_GH_TOKEN` must remain configured in the Cursor dashboard for merge and cleanup steps.

GitHub Actions uses **`EXECUTE_PLAN_BOT_TOKEN`** in the **`automation`** environment (not the dashboard) for execute-plan and for `envVars` on issue/dispatch agent launches. Project board updates use **`GH_PROJECTS_PAT`** in **`automation`**, not the bot PAT.

Full policy: `.cursor/skills/cloud-github-identity/SKILL.md`.

- Flutter 3.44.0 at `/opt/flutter/bin`, provisioned by `.cursor/Dockerfile`
- Environment: `.cursor/environment.json` + `.cursor/Dockerfile` — install/start via `.cursor/scripts/cloud-*.sh`

If a Cloud Agent pod reports missing `flutter` or `pg_ctlcluster`, confirm the repo uses Dockerfile mode (no `snapshot`
field in `.cursor/environment.json`) and rebuild — see below.

## Node scripts that call GitHub (sandbox egress proxy)

Node's built-in `fetch` ignores `HTTPS_PROXY` / `ALL_PROXY` unless `NODE_USE_ENV_PROXY=1` is set at process start, so a
direct call from a sandbox gets `401 Bad credentials`. A script that an agent runs and that calls GitHub with `fetch`
must call `reexecWithEnvProxy()` from `scripts/lib/env_proxy_reexec.js` **only when** `require.main === module`, and **before**
any module that calls GitHub with `fetch` is loaded. Covered today: `scripts/github_issue_workflow.js` and
`scripts/execute_plan_runtime.js`. Other scripts under `scripts/` that reach GitHub via `fetch` in agent sandboxes still
need an audit — tracking issue #2472 (`reexecWithEnvProxy` or route through `gh`). The `scripts/ci/*` and `.github/scripts/*` callers
run only in GitHub Actions, which has no proxy, so they need no change.

## Claude Code cloud sessions (`agathatrack` environment)

Claude Code on the web runs in a fresh container per session. Use the personal cloud environment **`agathatrack`**, not
**Default** (Default has no setup script, so the toolchain, server deps and dev database are all missing). Its setup
script runs as root after the repository is cloned, from the directory that holds the checkout. It makes
`./scripts/pre-push-changed.sh` work on the first run:

- Flutter 3.44.0 is the checksum-verified SDK from `scripts/flutter-sdk.sh` (the copy pre-push verifies), owned by root
  and linked at `/opt/flutter`;
- `flutter pub get`, `server` `npm ci`, and `shellcheck` (pre-push lints shell scripts);
- the AGENTS.md dev role and database (`user` with `LOGIN CREATEDB`, not superuser; `agatha_db`), then
  `e2e/scripts/bootstrap-db.sh`.

It is idempotent (about 6 s on a warm container). It runs only when a container is built fresh, not when a session resumes or its worker restarts; a restart stops PostgreSQL, so run `sudo pg_ctlcluster 16 main start` (AGENTS.md §PostgreSQL) after one. `flutter pub get` may rewrite `flutter_app/pubspec.lock` when the committed lock drifts from the SDK's pinned packages; do not commit that rewrite with unrelated work. The stored copy lives in the environment settings; keep this copy in
step when you change it:

```bash
set -e
# AgathaTrack cloud session setup: pre-push (./scripts/pre-push-changed.sh) works on the first run.
if [ -d AgathaTrack ]; then
  cd AgathaTrack
  # Flutter 3.44.0: the checksum-verified SDK that scripts/flutter-sdk.sh (pre-push) uses.
  (. scripts/flutter-sdk.sh && agatha_flutter_install)
  sdk="${XDG_CACHE_HOME:-$HOME/.cache}/agatha-track/flutter-3.44.0-linux"
  # The release tarball keeps uid 1000; as root, git then refuses the SDK ("dubious ownership").
  chown -R root:root "$sdk"
  ln -sfn "$sdk" /opt/flutter
  ln -sf /opt/flutter/bin/flutter /usr/local/bin/flutter
  ln -sf /opt/flutter/bin/dart /usr/local/bin/dart
  flutter config --no-analytics
  flutter precache --web
  (cd flutter_app && flutter pub get)
  (cd server && npm ci --no-audit --no-fund)
  cd ..
fi
# shellcheck: pre-push lints shell scripts.
command -v shellcheck >/dev/null || apt-get install -y shellcheck || (apt-get update && apt-get install -y shellcheck)
# PostgreSQL dev DB with the AGENTS.md defaults (user/password, agatha_db).
pg_ctlcluster 16 main start || true
psql_pg() { runuser -u postgres -- psql -tAc "$1"; }
psql_pg "select 1 from pg_roles where rolname='user'" | grep -q 1 || psql_pg "create role \"user\" login createdb password 'password'"
psql_pg "select 1 from pg_database where datname='agatha_db'" | grep -q 1 || psql_pg "create database agatha_db owner \"user\""
# Empty DB: canonical snapshot + migration ledger. Existing DB: pending migrations only.
if [ -d AgathaTrack ]; then (cd AgathaTrack && ./e2e/scripts/bootstrap-db.sh); fi
```

## Rebuild after a toolchain bump

The Flutter SDK is baked into the image via `.cursor/Dockerfile` (`FLUTTER_VERSION=3.44.0`). After a toolchain bump,
**new pods must rebuild** from that Dockerfile — `cloud-install.sh` only runs `pub get` / `npm ci`, it does not upgrade
`/opt/flutter`.

**Operator steps** (when agents still show Flutter 3.32 or `cloud-install.sh` fails the version gate):

1. Open [Cloud Agents → Environments](https://cursor.com/dashboard/cloud-agents#environments) for this repo.
2. Delete the saved environment for AgathaTrack, **or** create a fresh environment from the repo (do not use the
   interactive wizard snapshot — it ignores `build.dockerfile`).
3. Confirm `.cursor/environment.json` has `build.dockerfile` only — **no** `snapshot` field.
4. Start a new Cloud Agent from `main` (or a branch that includes the latest `.cursor/Dockerfile`).
5. Verify: `flutter --version` → **3.44.0** and `dart --version` → **3.12.x**.

`cloud-install.sh` fails fast when `/opt/flutter` exists but is the wrong version, with the message above.
