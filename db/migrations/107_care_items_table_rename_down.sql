-- Rollback Deploy 1 (#2405). Safe only when no writes targeted care_items / care_occurrences
-- outside the compatibility views (pre-check in migrate down tooling).

BEGIN;

DROP VIEW IF EXISTS health_occurrences;
DROP VIEW IF EXISTS health_entries;

ALTER TABLE care_occurrences RENAME TO health_occurrences;
ALTER TABLE care_items RENAME TO health_entries;

COMMIT;