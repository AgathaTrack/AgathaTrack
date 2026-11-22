# Protocol: database-and-migrations

**When:** Schema change, migration, backfill, constraints, indexes, persisted semantics.

**Scripts:** empty database → `APP_ENV=development ./e2e/scripts/bootstrap-db.sh` (canonical snapshot + migration ledger; refuses in production); existing
database → `cd server && node scripts/migrate.js up`. Never run `migrate.js up` on an empty database (AGENTS.md
§PostgreSQL).

---

## 1. Inspect

- Current schema (`server/migrations/` or canonical SQL)
- Migration history — no duplicate numbering
- Deployed-data implications (existing rows)

## 2. Requirements

- Forward migration only in repo workflow
- Integrity constraints explicit
- Transactions for multi-step changes
- Indexes for new query patterns
- Backfill for existing data when semantics change
- **Never assume production can reset its database**

## 3. Tests

- Fresh schema path: regenerate `db/schema/canonical.sql` (`scripts/db/regenerate-canonical.sh`), then
  `APP_ENV=development ./e2e/scripts/bootstrap-db.sh` on an empty database ([db-schema-bootstrap-plan](../../../docs/pipelines/db-schema-bootstrap-plan.md))
- Upgrade path from previous schema state
- Failure/rollback consideration documented in PR

## 4. Escalation (halt)

Destructive migration, large production data rewrite → autonomous-pr-policy §Escalation.

## 5. Verification

```bash
cd server && node scripts/migrate.js up       # existing database; an empty one takes APP_ENV=development ./e2e/scripts/bootstrap-db.sh
cd server && npx jest --env=node --forceExit  # domain tests
```

Real-DB integration tests when AuthZ/persistence critical (Pet Care hardening target).
