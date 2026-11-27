#!/usr/bin/env bash
# Resolve merge-base against origin/main for migration governance gates (fail closed).
set -euo pipefail

git fetch origin main --quiet 2>/dev/null || true
MERGE_BASE="$(git merge-base HEAD origin/main 2>/dev/null || true)"
if [[ -z "${MERGE_BASE}" ]]; then
  echo "${RESOLVE_MERGE_BASE_LABEL:-pre-push}: cannot resolve merge-base HEAD origin/main" >&2
  echo "Run: git fetch origin main" >&2
  exit 1
fi
printf '%s' "${MERGE_BASE}"