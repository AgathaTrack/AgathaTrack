#!/bin/bash

# Script to validate documentation integrity
# Checks for broken links, missing metadata, and duplicate content
# Usage: ./scripts/validate_docs.sh [--strict]

REPO_ROOT=$(git rev-parse --show-toplevel)
STRICT=false
ERRORS=0
BROKEN_LINKS=0
MISSING_HEADERS=0
ROOT_MISSING=0
DUPLICATE_FOUND=0
ARCHIVED_REFERENCES=0

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=true ;;
  esac
done

echo "Validating documentation..."
echo "Repository root: $REPO_ROOT"
echo "Strict mode: $STRICT"
echo ""

# 0. Placement, hex colour, and feature manifest gates (docs-canonical-layout phase 9)
echo "Running documentation placement and manifest gates..."
if ! node "$REPO_ROOT/scripts/check_doc_placement.js"; then
  ERRORS=$((ERRORS + 1))
fi
echo ""
if ! node "$REPO_ROOT/scripts/check_doc_placement.js" --hex-colors; then
  ERRORS=$((ERRORS + 1))
fi
echo ""
if ! node "$REPO_ROOT/scripts/check_doc_placement.js" --feature-manifest; then
  ERRORS=$((ERRORS + 1))
fi
echo ""

# Canonical docs gates (diff vs origin/main when available)
echo "Running canonical docs gates..."
BASE="origin/main"
if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  if ! node "$REPO_ROOT/scripts/check_docs_canonical.js" --base "$BASE"; then
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "  Skip check_docs_canonical (no $BASE — fetch origin/main for local parity)"
fi
echo ""

# Helper function to check if a file has valid YAML frontmatter
has_frontmatter() {
  local filepath="$1"
  # Check first line is --- and there's a closing --- with metadata fields in between
  local first_line=$(head -1 "$filepath")
  if [[ "$first_line" != "---" ]]; then
    return 1
  fi
  # Check there's at least one metadata field and a closing --- within first 10 lines
  if head -15 "$filepath" | grep -qE '^(title|owner|audience|status|last_updated|tags):' && \
     head -15 "$filepath" | tail -n +2 | grep -qE '^---$'; then
    return 0
  fi
  return 1
}

# 1. Check for broken markdown links (ordinary [label](path), repo-root /…, anchors)
echo "Checking for broken links in markdown files..."
LINK_CHECK_LOG=$(mktemp)
if node "$REPO_ROOT/scripts/lib/validate_markdown_links.mjs" "$REPO_ROOT" >"$LINK_CHECK_LOG" 2>&1; then
  cat "$LINK_CHECK_LOG"
else
  cat "$LINK_CHECK_LOG"
  BROKEN_LINKS=$(grep -c '^  Broken link' "$LINK_CHECK_LOG" 2>/dev/null || true)
  BROKEN_LINKS=${BROKEN_LINKS:-0}
  if [[ "$BROKEN_LINKS" -eq 0 ]]; then
    # Non-zero exit without broken-link lines is a checker failure, never a pass.
    echo "  Link checker failed without reporting broken links (checker error)"
    ERRORS=$((ERRORS + 1))
  else
    ERRORS=$((ERRORS + BROKEN_LINKS))
  fi
fi
rm -f "$LINK_CHECK_LOG"

# 2. Check for metadata headers in docs/
echo ""
echo "Checking for metadata headers in docs/..."

for filepath in $(find "$REPO_ROOT/docs" -name "*.md" -type f 2>/dev/null); do
  if ! has_frontmatter "$filepath"; then
    echo "  Missing metadata header: $filepath"
    MISSING_HEADERS=$((MISSING_HEADERS + 1))
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ $MISSING_HEADERS -eq 0 ]]; then
  echo "  All docs have metadata headers"
else
  echo "  Found $MISSING_HEADERS files without headers"
fi

# 3. Check for metadata headers in root .md files
echo ""
echo "Checking for metadata headers in root .md files..."

for filepath in "$REPO_ROOT"/*.md; do
  if [[ -f "$filepath" ]] && ! has_frontmatter "$filepath"; then
    echo "  Missing metadata header: $filepath"
    ROOT_MISSING=$((ROOT_MISSING + 1))
    ERRORS=$((ERRORS + 1))
  fi
done

if [[ $ROOT_MISSING -eq 0 ]]; then
  echo "  All root .md files have metadata headers"
else
  echo "  Found $ROOT_MISSING root files without headers"
fi

# 4. Check for duplicate content (basic check)
echo ""
echo "Checking for potential duplicate content..."

# pre-push.sh is deliberately not listed (DOCUMENTATION-STANDARDS-D-010): most mentions are
# one-line pointers to the canonical script, which is the pattern docs should follow.
DUPLICATE_PATTERNS=(
  "flutter pub get"
  "npm ci"
  "flutter analyze"
  "npx jest"
  "sudo pg_ctlcluster"
)

for pattern in "${DUPLICATE_PATTERNS[@]}"; do
  # Use fixed-string matching
  # Agent entry points repeat toolchain commands; threshold avoids false positives in strict mode.
  COUNT=$(grep -rF --include="*.md" "$pattern" "$REPO_ROOT/docs" 2>/dev/null | wc -l)
  if [[ $COUNT -gt 40 ]]; then
    echo "  Pattern '$pattern' appears $COUNT times in docs/ (may indicate duplication)"
    DUPLICATE_FOUND=$((DUPLICATE_FOUND + 1))
    if [[ "$STRICT" == true ]]; then
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

if [[ $DUPLICATE_FOUND -eq 0 ]]; then
  echo "  No obvious duplicate content detected"
else
  echo "  Found $DUPLICATE_FOUND patterns that may indicate duplication"
fi

# 5. Check for archived docs being referenced as active
echo ""
echo "Checking for references to archived docs..."

# List of archived files and their new paths
declare -A ARCHIVED_MAP=(
  ["docs/design/navigation-v2.md"]="docs/archived/navigation-v2.md"
  ["docs/experience-split-plan.md"]="docs/archived/experience-split-plan.md"
  ["docs/quality/review-2026-07-08.md"]="docs/archived/quality-review-2026-07-08.md"
)

for old_path in "${!ARCHIVED_MAP[@]}"; do
  new_path="${ARCHIVED_MAP[$old_path]}"
  # Check for references to the old path
  for filepath in $(find "$REPO_ROOT" -name "*.md" -type f -not -path "*/docs/archived/*" -not -path "*/.git/*" -not -path "*/node_modules/*" 2>/dev/null); do
    if grep -qF "$old_path" "$filepath" 2>/dev/null; then
      # Check if it also references the archived version
      if ! grep -qF "$new_path" "$filepath" 2>/dev/null; then
        echo "  Non-archived reference to archived doc in: $filepath ($old_path)"
        ARCHIVED_REFERENCES=$((ARCHIVED_REFERENCES + 1))
        if [[ "$STRICT" == true ]]; then
          ERRORS=$((ERRORS + 1))
        fi
      fi
    fi
  done
done

if [[ $ARCHIVED_REFERENCES -eq 0 ]]; then
  echo "  All archived doc references are correct"
else
  echo "  Found $ARCHIVED_REFERENCES references to archived docs"
fi

# Final report
echo ""
echo "=== Documentation Validation Report ==="
echo "Broken links: $BROKEN_LINKS"
echo "Missing headers (docs/): $MISSING_HEADERS"
echo "Missing headers (root): $ROOT_MISSING"
echo "Potential duplicates: $DUPLICATE_FOUND"
echo "Archived references: $ARCHIVED_REFERENCES"
echo "Total errors: $ERRORS"
echo ""

if [[ $ERRORS -eq 0 ]]; then
  echo "All documentation checks passed!"
  exit 0
else
  echo "Found $ERRORS documentation issues."
  exit 1
fi
