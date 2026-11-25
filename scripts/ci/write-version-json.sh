#!/usr/bin/env bash
# Write site-root version.json beside the Flutter web build (About + support context).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB_DIR="${WEB_DIR:-${ROOT}/flutter_app/build/web}"
OUT="${WEB_DIR}/version.json"
PUBSPEC="${ROOT}/flutter_app/pubspec.yaml"

if [[ ! -d "$WEB_DIR" ]]; then
  echo "::error::Web build output not found at ${WEB_DIR}" >&2
  exit 1
fi

GIT_SHA="${GITHUB_SHA:-}"
if [[ -z "$GIT_SHA" ]]; then
  GIT_SHA="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || true)"
fi
if [[ -z "$GIT_SHA" ]]; then
  echo "::error::Could not resolve git SHA for version.json (set GITHUB_SHA or run from a git checkout)" >&2
  exit 1
fi

python3 - "$OUT" "$PUBSPEC" "$GIT_SHA" <<'PY'
import json
import re
import sys

out_path, pubspec_path, git_sha = sys.argv[1:4]
version_line = ""
with open(pubspec_path, encoding="utf-8") as fh:
    for line in fh:
        if line.strip().startswith("version:"):
            version_line = line.split(":", 1)[1].strip()
            break
match = re.match(r"^(\S+?)(?:\+(\S+))?$", version_line)
app_version = match.group(1) if match else ""
if not app_version:
    raise SystemExit(f"::error::Missing or invalid version in {pubspec_path}" )

build_id = git_sha.strip().lower()
if len(build_id) < 7:
    raise SystemExit(f"::error::git SHA too short for version.json build id" )

short_build = build_id[:7]
payload = {
    "version": app_version,
    "build": short_build,
    "commit": build_id,
}
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
print(f"Wrote version.json ({app_version}+{short_build}, commit {build_id[:12]}…)")
PY