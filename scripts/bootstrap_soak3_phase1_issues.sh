#!/usr/bin/env bash
# Bootstrap soak3 phase 1 fixtures ([sandbox] soak3-*). Idempotent by title prefix.
set -euo pipefail
export GH_TOKEN="${OWNER_GH_TOKEN:-${GH_TOKEN:?GH_TOKEN required}}"

REPO="${GH_REPO:-AgathaTrack/AgathaTrack}"
PREFIX='[sandbox] soak3-'

existing() {
  gh search issues --repo "$REPO" "${PREFIX}" --state open --json title --limit 20 \
    | rg -o 'soak3-[0-9]+' || true
}

create_issue() {
  local title="$1"
  local body_file="$2"
  shift 2
  local labels=("$@")
  if gh search issues --repo "$REPO" "$title" --state open --json number -q '.[0].number' 2>/dev/null | rg -q .; then
    echo "skip (exists): $title" >&2
    gh search issues --repo "$REPO" "$title" --state open --json number,url -q '.[0]|"\(.number) \(.url)"'
    return 0
  fi
  local label_args=()
  for l in "${labels[@]}"; do label_args+=(--label "$l"); done
  gh issue create --repo "$REPO" --title "$title" --body-file "$body_file" "${label_args[@]}"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# soak3-01
cat >"$TMP/01.md" <<'EOF'
### Summary

Soak3 **phase 1** — baseline **To do → Ready**. Docs-only placeholder; no delivery in phase 1.

### Objective

When phase 2 runs, fix one typo in `docs/agent-efficiency/github-labels.md` (add a soak3 bullet under `pipeline-beta`). Phase 1 only proves spec + review convergence.

### Scope

- Phase 1: spec pass and two signed reviews; engine sets **Ready**.
- Phase 2 (later): single-character docs fix in `github-labels.md`.

### Out of Scope

Product code, workflows, delivery PRs during phase 1.

### Definition of Done

- [ ] Phase 1: org field **Stage** is **Ready** with signed reviews on file (no delivery PR).
- [ ] Phase 2 (later): typo fix merged with `Refs` this issue.

### Priority

Low

### Affected Area

docs (`docs/agent-efficiency/`)

### Security or Sensitive Area

No

### Delivery plan

Method: PR (phase 2 only)

Phase 1: **stop at Ready** — do not launch delivery, do not open a branch.

Phase 2: branch from `main`, one-line docs edit, `Refs` this issue.

```agent-paths
{"globs":["docs/agent-efficiency/github-labels.md"]}
```

<!-- soak3:expect todo.request -> todo.dor-pass -> analysis.converged -> Ready (phase 1) -->
EOF

# soak3-02
cat >"$TMP/02.md" <<'EOF'
### Summary

Soak3 **phase 1** — **`Blocked=question`** from **To do** when Definition of Done has no checkboxes.

### Objective

After owner names the target line, add DoD checkboxes and converge (phase 1 may end at Ready in a follow-up tick).

### Scope

`docs/agent-efficiency/github-labels.md` only (future typo).

### Out of Scope

Guessing the line without owner input.

### Definition of Done

Owner must name the target line in a comment. Until then, **no** `- [ ]` items here (DoR `no-checkbox`).

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

Phase 1: question path only. Phase 2: PR after Ready.

```agent-paths
{"globs":["docs/agent-efficiency/github-labels.md"]}
```

<!-- soak3:expect Blocked=question or spec cannot sign pass until DoD checkboxes -->
EOF

# soak3-03
cat >"$TMP/03.md" <<'EOF'
### Summary

Soak3 **phase 1** — **`Blocked=paused`** skip (PIPE-V2-D-SOAK-005 proposed).

### Objective

Prove the engine does not mutate the issue while paused.

### Scope

No code changes.

### Out of Scope

Delivery.

### Definition of Done

- [ ] Operator set org field **Blocked=paused** before soak ticks.
- [ ] Tick logs show **blocked.paused** with no `pipeline_v2_applied` writes.

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

None in phase 1.

<!-- soak3:expect blocked.paused on every on tick; owner clears paused after soak -->
EOF

# soak3-04
cat >"$TMP/04.md" <<'EOF'
### Summary

Soak3 **phase 1** — round robin on **first spec doorbell** (fresh issue).

### Objective

Observe which agent id receives `todo.request` on a virgin issue.

### Scope

Docs placeholder; phase 2 typo in `github-issue-workflow.md` §Labels (one word).

### Out of Scope

Delivery in phase 1.

### Definition of Done

- [ ] Phase 1: **Ready** after reviews.
- [ ] Tick log records `todo.request` agent id consistent with board round robin.

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

Phase 1: stop at **Ready**.

```agent-paths
{"globs":["docs/agent-efficiency/github-issue-workflow.md"]}
```

<!-- soak3:expect todo.request agent = next startable id on ring -->
EOF

# soak3-05
cat >"$TMP/05.md" <<'EOF'
### Summary

Soak3 **phase 1** — **Claude** spec doorbell on **To do**.

### Objective

When Claude is the picked agent, `pipeline-claude-run.yml` runs for spec purpose.

### Scope

Docs placeholder.

### Out of Scope

Delivery phase 1.

### Definition of Done

- [ ] Phase 1: spec doorbell attributed to **claude-a** or **claude-b** in `v2:launch` when Claude is ring pick.
- [ ] **Ready** after reviews.

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

Phase 1: stop at **Ready**.

```agent-paths
{"globs":["docs/agent-efficiency/github-labels.md"]}
```

<!-- soak3:expect Claude runner spec doorbell at least once before Ready -->
EOF

# soak3-06
cat >"$TMP/06.md" <<'EOF'
### Summary

Soak3 **phase 1** — **SOAK-007**: reviews between **`dry-run`** ticks.

### Objective

Signed reviews posted while repo is `dry-run` must not move **Stage** until the next `on` tick.

### Scope

Docs placeholder.

### Out of Scope

Delivery phase 1.

### Definition of Done

- [ ] At least one signed review lands during `dry-run`.
- [ ] **Ready** only after a subsequent `on` tick (`analysis.converged`).

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

Phase 1: stop at **Ready**.

```agent-paths
{"globs":["docs/agent-efficiency/github-issue-workflow.md"]}
```

<!-- soak3:expect Stage unchanged across dry-run review; converged on next on -->
EOF

# soak3-07
cat >"$TMP/07.md" <<'EOF'
### Summary

Soak3 **phase 1** — two **distinct agent ids** approve when body editor uses a shared login (PIPE-V2-D-SOAK-001 class).

### Objective

Convergence requires two ups from different ids when the last body editor is not a lone agent id.

### Scope

Docs placeholder.

### Out of Scope

Delivery phase 1.

### Definition of Done

- [ ] Phase 1: **Ready** with `approvedBy` listing two distinct ids in tick evidence.

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

Phase 1: stop at **Ready**.

```agent-paths
{"globs":["docs/agent-efficiency/github-labels.md"]}
```

<!-- soak3:expect analysis.converged approvedBy length 2 -->
EOF

# soak3-08
cat >"$TMP/08.md" <<'EOF'
### Summary

Soak3 **phase 1** — **no-convergence** at vote cap (adversarial reviews).

### Objective

Reach **`Blocked=no-convergence`** after `limits.noConvergenceVotes` without Ready.

### Scope

Adversarial fixture — reviews should not converge.

### Out of Scope

Delivery.

### Definition of Done

- [ ] Engine sets **`Blocked=no-convergence`** before **Ready**.
- [ ] Owner resets fixture after observing row.

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

None — may never reach Ready in phase 1.

```agent-paths
{"globs":["docs/agent-efficiency/github-labels.md"]}
```

<!-- soak3:expect analysis.no-convergence; owner clears to retest -->
EOF

# soak3-09
cat >"$TMP/09.md" <<'EOF'
### Summary

Soak3 **phase 1** — **manual-only** control (engine skip).

### Objective

Issue carries `manual-only`; tick logs show no writes.

### Scope

N/A

### Out of Scope

Pipeline automation.

### Definition of Done

- [ ] `pipeline_v2_action` reason **manual-only** (dry-run or on).

### Priority

Low

### Affected Area

docs

### Security or Sensitive Area

No

### Delivery plan

Hand-driven only.

<!-- soak3:expect manual-only skip -->
EOF

echo "Creating soak3 phase 1 fixtures on $REPO ..." >&2
create_issue "${PREFIX}01 happy path: To do to Ready (spec+review)" "$TMP/01.md" task pipeline-beta
create_issue "${PREFIX}02 question: Definition of Done withheld" "$TMP/02.md" task pipeline-beta
create_issue "${PREFIX}03 paused: engine skip" "$TMP/03.md" task pipeline-beta
create_issue "${PREFIX}04 round robin: first spec pickup" "$TMP/04.md" task pipeline-beta
create_issue "${PREFIX}05 claude spec doorbell" "$TMP/05.md" task pipeline-beta
create_issue "${PREFIX}06 dry-run review lag (SOAK-007)" "$TMP/06.md" task pipeline-beta
create_issue "${PREFIX}07 two distinct reviewers" "$TMP/07.md" task pipeline-beta
create_issue "${PREFIX}08 no-convergence cap" "$TMP/08.md" task pipeline-beta
create_issue "${PREFIX}09 control: manual-only" "$TMP/09.md" task pipeline-beta manual-only

echo "Done. Set Stage=To do on the project for each open soak3 issue." >&2