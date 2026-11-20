---
title: Database schema bootstrap plan
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-20
tags: [database, bootstrap, plan]
---
# Database schema bootstrap — phased plan

**Status:** Phase 3 complete (fast bootstrap). Phases 4–5 tracked in execute-plan `db-schema-bootstrap-345`.  
**Principle:** Forward-only migrations are the production authority. The canonical schema is a **CI-verified snapshot** for fast bootstraps and drift detection — not a hand-edited alternate truth.

See also: [DEPLOYMENT_DB.md](../DEPLOYMENT_DB.md) (deploy commands), [calendar-dates.md](./calendar-dates.md) (wire format).

---

## Operating model

| Artifact | Path | Role | Production? |
|----------|------|------|-------------|
| **Incremental migrations** | `db/migrations/NNN_*.sql` | Authoritative upgrade path | **Yes** — `migrate.js up` only |
| **Migration manifest** | `db/schema/migration-manifest.json` | Ledger of incrementals; CI integrity | No (metadata) |
| **Canonical snapshot** | `db/schema/canonical.sql` | Generated end-state DDL; drift check | No (bootstrap only) |
| **Legacy baseline** | `db/migrations/archive/v3__initial_uuid_schema.sql` | Regeneration + CI legacy path only | Never in deploy |
| **UAT/demo seeds** | `server/db/seeds/` | Idempotent synthetic personas (Node) | **Never** |

### Bootstrap profiles

There is **one** checked-in schema artifact (`db/schema/canonical.sql`). UAT does not use a second “canonical with data” SQL file. Synthetic data is applied **after** a clean bootstrap.

| Profile | Steps | Typical use |
|---------|--------|-------------|
| **clean** | Apply `canonical.sql` on an empty database → `server/scripts/seed-migration-ledger.js` | Dev, CI/E2E, clean UAT (schema only, no personas) |
| **uat-demo** | **clean** → `node server/scripts/seed.js` (scenarios) | UAT reset, demos, rich manual/Playwright testing |

**Commands:**

| Profile | Command |
|---------|---------|
| clean | `e2e/scripts/bootstrap-db.sh` (empty DB) or existing DB → `node scripts/migrate.js up` |
| uat-demo (full wipe) | `scripts/db/uat-reset.sh` (non-prod; drop DB + clean + all scenarios) |
| uat-demo (data only) | `scripts/db/uat-refresh-demo.sh` (truncate app tables, re-seed; keeps schema) |

**Production and long-lived databases:** only `node scripts/migrate.js up` (forward SQL + registered JS hooks). Do not apply `canonical.sql` to replace data on a database that has served real users without a separate save/migrate workflow (that workflow is documented later).

### Data categories

| Type | Examples | Where |
|------|----------|-------|
| **Reference data** | Rows the app assumes exist on day one in every environment | Forward migration only |
| **Demo / UAT data** | Alice, Happy Paws Clinic, foster scenarios | `server/db/seeds/` via `seed.js` only; **uat-demo** profile |

### Code migrations (`code_migrations` in manifest)

Some incrementals pair SQL with Node backfills (`CODE_MIGRATIONS` in `server/scripts/migrate.js`). On an **empty** database:

- **clean** bootstrap applies end-state DDL from `canonical.sql` only (generated after the legacy path ran once).
- JS backfills do **not** run on fast bootstrap (nothing to backfill).
- `seed-migration-ledger.js` still records those files in `_migrations` so `migrate.js up` will not replay them.

### Safeguarding (principle)

These rules are enforced today by `APP_ENV` guards and deploy audits; operational workflows for prod export/restore are tracked separately.

| ID | Rule |
|----|------|
| P1 | Clean bootstrap (canonical apply, `DROP DATABASE`, ledger seed on empty) is **non-production only**. |
| P2 | Production deploy paths may invoke **only** `migrate.js up`. |
| P3 | Destructive reset refuses when `APP_ENV=production` (or equivalent). |
| P4 | Regenerating `canonical.sql` is dev/CI tooling — never prod deploy. |
| P5 | Synthetic seeds never run in production. |

**Anti-pattern:** Running `uat-reset`, drop-and-recreate, or `canonical.sql` against a database that holds or held production data without an approved backup and migration plan.

### Decision log

| ID | Date | Decision |
|----|------|----------|
| D-DB-BOOT-001 | 2026-11-20 | Single clean schema snapshot; UAT = clean + Node seeds (no second canonical SQL). Prod authority remains incremental `migrate.js up`. Prod replace/save workflows out of scope for this doc until a dedicated runbook lands. |

---

## Phase 1 — Validation infrastructure (current)

**Outcome:** Prove the bootstrap path produces a schema that matches the committed canonical snapshot, without changing prod/UAT deploy behaviour.

### Deliverables

| Item | Purpose |
|------|---------|
| `db/schema/migration-manifest.json` | Authoritative list of `NNN_*.sql` files |
| `db/schema/canonical.sql` | Generated snapshot at migration 020 |
| `scripts/db/check-migration-manifest.js` | Manifest ↔ disk integrity |
| `scripts/db/normalize-schema-dump.js` | Stable `pg_dump` comparison |
| `scripts/db/check-schema-equivalence.sh` | Bootstrap path → dump → diff canonical |
| `scripts/db/regenerate-canonical.sh` | Regenerate snapshot after schema PRs |

### Developer workflow (schema change PR)

1. Add `db/migrations/021_feature.sql` (forward-only).
2. Append filename to `db/schema/migration-manifest.json`.
3. Run `scripts/db/regenerate-canonical.sh` and commit `canonical.sql`.
4. Run `scripts/db/check-schema-equivalence.sh` locally (Postgres required).
5. Production/UAT deploy unchanged: `node scripts/migrate.js up` only.

### Exit criteria

- [x] Manifest lists all incremental migrations on disk.
- [x] Canonical snapshot regenerated from v3 + 001–020 bootstrap path.
- [x] Equivalence check passes locally.
- [x] Manifest check in governance pre-push (lightweight, no Postgres).
- [x] Equivalence check in PR startup smoke (Postgres already provisioned).

### Non-goals (Phase 1)

- No bootstrap path switch (still `v3` + incrementals).
- No seed layer.
- No prod credential or deploy changes.

---

## Phase 2 — Blocking CI gate

**Outcome:** Schema drift cannot merge to `main`.

**Status:** Delivered alongside Phase 1 — `pr-startup-smoke` runs equivalence after bootstrap (already behind `ci-gate / CI passed`).

### Remaining work

1. ~~Add equivalence check to PR startup smoke~~ (done).
2. Document in [ci-cd-gates.md](./ci-cd-gates.md) (optional follow-up).
3. `pre-push-changed.sh`: schema-path changes run equivalence when Postgres is up (done).

### Exit criteria

- [x] PR with stale `canonical.sql` fails CI (via startup smoke).
- [x] PR with manifest/disk mismatch fails governance.
- [x] `ci-gate / CI passed` includes schema drift (via startup-smoke).

---

## Phase 3 — Fast bootstrap switch

**Outcome:** New environments apply one canonical file instead of v3 + 20 replay steps.

**Status:** Complete — `bootstrap-db.sh` applies `canonical.sql` + migration ledger; v3 archived.

### Delivered

1. `e2e/scripts/bootstrap-db.sh` — canonical snapshot + `seed-migration-ledger.js` on empty DB
2. `server/scripts/seed-migration-ledger.js` — pre-seeds `_migrations` from manifest
3. `scripts/db/check-bootstrap-paths-equivalence.sh` — legacy ≡ fast path (CI)
4. `db/migrations/v3__initial_uuid_schema.sql` → `archive/` (legacy regeneration + CI only)

### Exit criteria

- [x] Fast bootstrap path in E2E/CI
- [x] Dual-path equivalence CI gate
- [x] v3 archived; docs updated

---

## Phase 4 — UAT/demo seed layer

**Outcome:** Human testers get stable personas without API signup friction.

**Status:** Complete — idempotent seed script + `uat-reset.sh` with `APP_ENV` guards.

### Delivered

- `server/scripts/seed.js` — scenarios `guardian`, `org-clinic`, `all`
- `scripts/db/uat-reset.sh` — drop + bootstrap + seed (non-prod only)
- `scripts/db/guard-non-prod.js` — shared production refusal helper
- `docs/e2e/uat-demo-personas.md` — stable credentials and UUIDs

### Exit criteria

- [x] Documented one-command UAT refresh (`scripts/db/uat-reset.sh`)
- [x] `APP_ENV=production` refuses seed/reset
- [x] Jest coverage for guard + demo constants

---

## Phase 5 — Production hardening

**Outcome:** Prod can only run the narrow migration path; destructive ops impossible by design.

**Status:** Complete — deploy audit, `APP_ENV` guards on destructive scripts, production policy in `DEPLOYMENT_DB.md`.

### Delivered

1. `APP_ENV=production` guards on `regenerate-canonical`, `uat-reset`, `seed`, legacy bootstrap, and DB-reset equivalence checks
2. `scripts/ci/assert-prod-deploy-db-commands.sh` — deploy scripts must not reference bootstrap/seed
3. Production policy table in `DEPLOYMENT_DB.md` (credentials + expand-and-contract)

### Exit criteria

- [x] Prod deploy checklist documented
- [x] Separate migration DB role documented (recommended policy)
- [x] No seed/reset in prod deploy scripts (CI assertion)

---

## Command reference

| Command | Postgres? | When |
|---------|-----------|------|
| `node scripts/db/check-migration-manifest.js` | No | Every schema PR; governance |
| `scripts/db/check-schema-equivalence.sh` | Yes | After schema changes; CI Phase 2 |
| `scripts/db/regenerate-canonical.sh` | Yes | After new migration committed |
| `node scripts/migrate.js up` | Yes | **Prod/UAT deploy only** |
| `e2e/scripts/bootstrap-db.sh` | Yes | **clean** profile — canonical + migration ledger |
| `scripts/db/uat-reset.sh` | Yes | **uat-demo** profile — drop + clean + `seed.js --scenario=all` |
| `scripts/db/bootstrap-legacy-db.sh` | Yes | Regenerate canonical + CI path equivalence only |

### Schema change checklist (every PR)

1. Add forward-only `db/migrations/NNN_*.sql` (and `_down` if used locally).
2. Register JS hook in `migrate.js` when needed; add name to manifest `code_migrations`.
3. Append filename to `db/schema/migration-manifest.json` (sorted).
4. Run `scripts/db/regenerate-canonical.sh`; commit `db/schema/canonical.sql`.
5. Run `scripts/db/check-bootstrap-paths-equivalence.sh` and `scripts/db/check-schema-equivalence.sh` when Postgres is available.
6. Update demo scenarios under `server/db/seeds/scenarios/` only when **uat-demo** data must change.

---

## Migration authoring rules (all phases)

1. **Forward-only** — no `down` in prod path; add a new migration to revert.
2. **No `gen_random_uuid()` in SQL** — generate UUIDs in Node (see `016` pattern).
3. **Reference vs demo** — prod-required rows in migrations; personas in seeds only.
4. **Expand-and-contract** for breaking changes: add → backfill → deploy code → drop (later migration).

---

## Related debt

| Item | Tracking |
|------|----------|
| v3 drift (inlines 001–007 only) | Resolved by canonical snapshot; v3 retired Phase 3 |
| Hand-merge policy in DEPLOYMENT_DB.md | Superseded by regenerate script |
| E2E API-only seeds | Phase 4 — promote stable personas to SQL |
