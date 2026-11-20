---
name: Cloud container bootstrap and checks it cannot run
description: Check prerequisites in one pass, keep destructive steps out of long runs, and report checks the container cannot run instead of rebuilding infrastructure.
---

A fresh cloud container may be missing the toolchain, server dependencies or the dev database
(Claude Code: the session started on **Default** instead of the `agathatrack` environment; see
`docs/engineering/cursor-cloud-environment.md`).

**Why:** On 2026-11-20 an agent discovered missing pieces one full `pre-push-changed.sh` run at a time
(Flutter, then `js-yaml`, then `shellcheck`, then PostgreSQL). It ran `migrate.js up` on an empty
database, which left a partial `_migrations` table that broke `bootstrap-db.sh`. It then chained a
database drop with a long gate run in one command, which was interrupted with the database in an
unknown state. Meanwhile the failing checks (197 DB integration tests) were unrelated to the change.

**How to apply:**

- Before a gate run, check every prerequisite in one read-only pass: `flutter`/`dart` version, `server/node_modules`,
  `shellcheck`, `pg_lsclusters`, the `user` role, `agatha_db`, and its `_migrations` count.
- Empty database: `./e2e/scripts/bootstrap-db.sh`. Only an existing database takes `migrate.js up`.
- Never put a destructive step (drop, reset, `rm -rf`) in the same command as a long run. Run it alone, check the result,
  then start the run.
- If a check cannot run in the container and the change does not touch what it covers, report it (PR body: which check,
  why, what CI covers) instead of building infrastructure to make it green. Fix the environment setup separately.
