#!/usr/bin/env bash
# Fail closed before destructive or bootstrap DB shell operations.
# Loads server/.env when present; caller-exported APP_ENV/NODE_ENV wins over .env.
#
# Usage:
#   ROOT="$(cd .../repo && pwd)" scripts/db/lib/require-non-prod.sh <operation-name>
set -euo pipefail

OPERATION="${1:-}"
if [[ -z "$OPERATION" ]]; then
  echo "require-non-prod: missing operation name" >&2
  exit 1
fi

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${ROOT:-$(cd "${LIB_DIR}/../../.." && pwd)}"

caller_app_set=false
caller_node_set=false
if [[ -v APP_ENV ]]; then
  caller_app_set=true
  caller_app="$APP_ENV"
fi
if [[ -v NODE_ENV ]]; then
  caller_node_set=true
  caller_node="$NODE_ENV"
fi

if [[ -f "${ROOT}/server/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT}/server/.env"
  set +a
fi

if [[ "$caller_app_set" == true ]]; then
  export APP_ENV="$caller_app"
elif [[ "$caller_node_set" == true ]]; then
  unset APP_ENV
fi

if [[ "$caller_node_set" == true ]]; then
  export NODE_ENV="$caller_node"
fi

resolved="${APP_ENV:-${NODE_ENV:-}}"

if [[ -z "$resolved" ]]; then
  echo "Refusing ${OPERATION}: set APP_ENV (or NODE_ENV) to a non-production value (e.g. development, ci, uat)" >&2
  exit 1
fi

if [[ "$resolved" == "production" ]]; then
  echo "Refusing ${OPERATION} when APP_ENV/NODE_ENV is production" >&2
  exit 1
fi

export APP_ENV="$resolved"