#!/usr/bin/env bash
# Regression tests for fail-closed non-prod guards on DB wrapper scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PSQL_LOG="${TMP}/psql-calls.log"
: >"$PSQL_LOG"

cat >"${TMP}/psql" <<EOF
#!/usr/bin/env bash
echo "psql-invoked" >> "${PSQL_LOG}"
exec "$(command -v psql)" "\$@"
EOF
chmod +x "${TMP}/psql"

NODE_LOG="${TMP}/node-calls.log"
: >"$NODE_LOG"

cat >"${TMP}/node" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == *"bootstrap-db"* ]] || [[ "${BASH_SOURCE[0]}" == *node ]]; then
  :
fi
echo "$*" >> "${NODE_LOG:-/dev/null}"
# Stub: first arg path may be truncate/seed — refuse running real DB work in guard tests
if [[ "$*" == *"truncate-data"* ]] || [[ "$*" == *"seed.js"* ]]; then
  exit 0
fi
exit 0
EOF
chmod +x "${TMP}/node"

write_env_fixture() {
  local dir="$1"
  local app_env="${2:-}"
  mkdir -p "${dir}/server"
  if [[ -n "$app_env" ]]; then
    printf 'APP_ENV=%s\n' "$app_env" >"${dir}/server/.env"
  else
    : >"${dir}/server/.env"
  fi
}

assert_refused() {
  local want_desc="$1"
  shift
  : >"$PSQL_LOG"
  set +e
  env -i HOME="$HOME" PATH="${TMP}:${PATH}" ROOT="$ROOT" "$@" >/dev/null 2>&1
  local code=$?
  set -e
  if [[ "$code" -eq 0 ]]; then
    echo "FAIL: expected refusal for $want_desc (exit 0)" >&2
    exit 1
  fi
  if [[ -s "$PSQL_LOG" ]]; then
    echo "FAIL: psql invoked for $want_desc" >&2
    exit 1
  fi
}

# --- require-non-prod.sh unit cases ---
assert_refused "APP_ENV=production" \
  env APP_ENV=production bash "${ROOT}/scripts/db/lib/require-non-prod.sh" test-op

assert_refused "NODE_ENV=production only" \
  env NODE_ENV=production bash "${ROOT}/scripts/db/lib/require-non-prod.sh" test-op

FIXTURE="${TMP}/env-only-production"
write_env_fixture "$FIXTURE" production
assert_refused "APP_ENV=production only in server/.env" \
  env -i HOME="$HOME" ROOT="$FIXTURE" bash "${ROOT}/scripts/db/lib/require-non-prod.sh" test-op

assert_refused "no env set" \
  env -i HOME="$HOME" ROOT="${TMP}/empty-root" bash "${ROOT}/scripts/db/lib/require-non-prod.sh" test-op

# --- uat-reset.sh (DROP DATABASE) ---
assert_refused "uat-reset APP_ENV=production" \
  env -i HOME="$HOME" PATH="${TMP}:${PATH}" ROOT="$ROOT" APP_ENV=production \
  bash "${ROOT}/scripts/db/uat-reset.sh"

# --- uat-refresh-demo.sh (truncate) ---
assert_refused "uat-refresh NODE_ENV=production only" \
  env -i HOME="$HOME" PATH="${TMP}:${PATH}" ROOT="$ROOT" NODE_ENV=production \
  bash "${ROOT}/scripts/db/uat-refresh-demo.sh"

# --- bootstrap-db.sh ---
assert_refused "bootstrap-db unset env" \
  env -i HOME="$HOME" PATH="${TMP}:${PATH}" ROOT="$ROOT" \
  bash "${ROOT}/e2e/scripts/bootstrap-db.sh"

echo "require-non-prod-wrappers: OK"