#!/usr/bin/env bash
# Bundle R11 verify script for appleboy script_path upload.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NM_LIB="${ROOT}/scripts/ci/assert-node-modules-symlink.lib.sh"
REMOTE="${ROOT}/scripts/ci/uat-r11-verify-remote.sh"
OUT="${ROOT}/.ci-uat-r11-verify.sh"

{
  echo '#!/usr/bin/env bash'
  echo 'set -euo pipefail'
  cat "$NM_LIB"
  echo
  awk '/^HOME=.*uat_nm_home_dir/,0' "$REMOTE"
} >"$OUT"
chmod +x "$OUT"

for sentinel in UAT_R11_VERIFY_BEGIN UAT_R11_VERIFY_END; do
  if ! grep -qF "$sentinel" "$OUT"; then
    echo "::error::${OUT} missing sentinel ${sentinel}" >&2
    exit 1
  fi
done

echo "Wrote ${OUT} ($(wc -l <"$OUT") lines)"