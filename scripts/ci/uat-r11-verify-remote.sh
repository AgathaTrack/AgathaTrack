#!/usr/bin/env bash
# R11 operational verification on UAT (DEBT-OPS-R11 #1546): care tick + repair dry-run.
set -euo pipefail

# shellcheck source=assert-node-modules-symlink.lib.sh
source "$(cd "$(dirname "$0")" && pwd)/assert-node-modules-symlink.lib.sh"

HOME="$(uat_nm_home_dir)"
export HOME

SITE_ROOT="${UAT_SITE_ROOT:-${HOME}/uat.agathatrack.com}"
APPDIR="${SITE_ROOT}/backend"
LOG_FILE="${HOME}/logs/care_tick_uat.log"
export APP_ENV=uat
export UAT_APP_DIR="${APPDIR}"

echo "UAT_R11_VERIFY_BEGIN"
echo "app_dir=${APPDIR}"
echo "log_file=${LOG_FILE}"

cd "${APPDIR}"

if ! uat_nm_use_node; then
  echo "::error::node not found — cannot run R11 verify"
  exit 1
fi
echo "node_bin=${UAT_NODE_BIN}"

echo "=== WP2: one-shot care_tick.js ==="
"${UAT_NODE_BIN}" scripts/care/care_tick.js

echo "=== WP2: cPanel cron (crontab) ==="
if crontab -l 2>/dev/null | grep -F 'care_tick.js'; then
  echo "cron_line=found"
else
  echo "::warning::No care_tick.js line in crontab — cron may not be installed"
fi

echo "=== WP2: care_tick_uat.log (last 25 lines) ==="
if [[ -f "${LOG_FILE}" ]]; then
  tail -n 25 "${LOG_FILE}"
else
  echo "::warning::Log file missing: ${LOG_FILE}"
fi

echo "=== WP3: repair_occurrences.js --dry-run ==="
"${UAT_NODE_BIN}" scripts/care/repair_occurrences.js --dry-run

echo "UAT_R11_VERIFY_END"