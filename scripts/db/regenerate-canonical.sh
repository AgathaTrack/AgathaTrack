#!/usr/bin/env bash
# Regenerate db/schema/canonical.sql from the legacy bootstrap path (authoritative build).
# After adding migrations: update manifest, run this, commit canonical.sql.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ROOT="$ROOT" bash "${ROOT}/scripts/db/lib/require-non-prod.sh" regenerate-canonical

export PGUSER="${PGUSER:-user}"
export PGPASSWORD="${PGPASSWORD:-password}"
export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGDATABASE="${PGDATABASE:-agatha_db}"
CANONICAL="${CANONICAL_SQL:-${ROOT}/db/schema/canonical.sql}"
HEADER="${ROOT}/db/schema/canonical.header.sql"
PG_ISREADY_BIN="${REGENERATE_PG_ISREADY:-pg_isready}"
PSQL_BIN="${REGENERATE_PSQL:-psql}"
PG_DUMP_BIN="${REGENERATE_PG_DUMP:-pg_dump}"
BOOTSTRAP="${REGENERATE_BOOTSTRAP:-${ROOT}/scripts/db/bootstrap-legacy-db.sh}"
NORMALIZE="${REGENERATE_NORMALIZE:-${ROOT}/scripts/db/normalize-schema-dump.js}"

stage_fail() {
  local stage="$1"
  echo "regenerate-canonical: stage ${stage} failed" >&2
  exit 1
}

if ! "$PG_ISREADY_BIN" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -q 2>/dev/null; then
  echo "regenerate-canonical: PostgreSQL not ready at ${PGHOST}:${PGPORT}" >&2
  stage_fail postgres
fi

if ! "$PSQL_BIN" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${PGDATABASE}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${PGDATABASE}";
CREATE DATABASE "${PGDATABASE}" OWNER "${PGUSER}";
SQL
then
  stage_fail reset
fi

if ! bash "$BOOTSTRAP"; then
  stage_fail bootstrap
fi

canon_dir="$(dirname "$CANONICAL")"
mkdir -p "$canon_dir"
raw="$(mktemp "${canon_dir}/.canonical.raw.XXXXXX")"
tmp="$(mktemp "${canon_dir}/.canonical.sql.XXXXXX")"
cleanup() {
  rm -f "$raw" "$tmp"
}
trap cleanup EXIT

# Dump and normalise into a sibling of the committed file. Rename only after both succeed,
# so a failed dump or normaliser cannot truncate canonical.sql.
if ! {
  cat "$HEADER"
  "$PG_DUMP_BIN" -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    --schema-only --no-owner --no-privileges
} >"$raw"; then
  stage_fail dump
fi

if ! node "$NORMALIZE" <"$raw" >"$tmp"; then
  stage_fail normalize
fi

if [[ ! -s "$tmp" ]]; then
  stage_fail validate
fi

mv -f "$tmp" "$CANONICAL"
tmp=""
rm -f "$raw"
raw=""
trap - EXIT

echo "Wrote ${CANONICAL}"
echo "Next: scripts/db/check-bootstrap-paths-equivalence.sh && scripts/db/check-schema-equivalence.sh"
