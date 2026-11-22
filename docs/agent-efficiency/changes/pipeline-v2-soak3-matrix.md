---
title: Pipeline v2 soak3 matrix (phase 1 — To do → Ready)
owner: Agent efficiency
audience: owner
status: proposed
status_since: 2026-11-22
folds_into: docs/agent-efficiency/github-issue-workflow.md
last_updated: 2026-11-22
tags: [agent, pipeline, soak]
related_prs: []
---

# Soak3 phase 1 — **To do → Ready** only

**Purpose:** Re-test spec doorbell, Definition of Ready, In analysis review, and **`analysis.converged` → Ready** without delivery noise. Soak2 lessons: [pipeline-v2-soak2-findings.md](./pipeline-v2-soak2-findings.md). **Pause after Ready** — phase 2 (Ready → Done) is a separate programme.

---

## Operating mode

| Setting | Value |
|---------|--------|
| `ISSUE_PIPELINE_V2` | `dry-run` until fixtures filed; then short `on` bursts |
| `ISSUE_PIPELINE_V2_LABEL` | `pipeline-beta` |
| `WIP_LIMIT` | unset (default cap) — phase 1 does not launch delivery |
| Scope | Only issues titled `[sandbox] soak3-*` with label `pipeline-beta` |

**Setup (once per fixture batch):**

1. File issues below (or use `scripts/bootstrap_soak3_phase1_issues.sh` on `main` after merge).
2. On the Pawpet project board, set org field **`Stage`** = **To do** for each fixture (project auto-add may default elsewhere).
3. Clear **`Blocked`** unless the row requires it (e.g. soak3-03 **paused**, soak3-02 after engine sets **question**).
4. Confirm **`pipeline-beta`** label on every fixture; **`manual-only`** only on soak3-09.

**Pass criteria for phase 1:** each row reaches the expected **`pipeline_v2_action`** row while `writes: true`, or the expected skip/`blocked` reason in dry-run.

---

## Fixture table

| ID | GitHub | Rows exercised | Expected outcome |
|----|--------|----------------|------------------|
| soak3-01 | **#2527** | `todo.request` → spec pass → `todo.dor-pass` → `analysis.request` → `analysis.converged` | **Ready**; two distinct reviewers on human-edited body |
| soak3-02 | **#2528** | `todo.request`; spec cannot sign DoR | **`Blocked=question`** or spec posts question; stays **To do** until DoD checkboxes added |
| soak3-03 | **#2529** | any tick | **`blocked.paused`** — no engine writes while **`Blocked=paused`** |
| soak3-04 | **#2530** | `todo.request` | First spec pickup follows **round robin** (PIPE-V2-D-SOAK-006) |
| soak3-05 | **#2531** | `todo.request` | **claude-a** (or next Claude id) runs spec doorbell when eligible |
| soak3-06 | **#2532** | `analysis.request` / reviews in `dry-run` | **SOAK-007:** reviews land between ticks; **`analysis.converged`** only on next **`on`** tick |
| soak3-07 | **#2533** | `analysis.request` + convergence | Two **distinct ids** approve when spec editor uses shared login (PIPE-V2-D-SOAK-001 class) |
| soak3-08 | **#2534** | `analysis.*` until vote cap | **`Blocked=no-convergence`** at `limits.noConvergenceVotes` (6) with adversarial pattern |
| soak3-09 | **#2535** | tick | **`manual-only`** — `pipeline_v2_planned`, no `applied` writes |

Issue numbers are filled when fixtures are bootstrapped on GitHub; re-run the bootstrap script after merge to refresh this table if numbers differ.

---

## Rows **not** in phase 1 (defer to soak3 phase 2 or later)

- `ready.launch`, `progress.*`, `launch-failed` / preflight (#2506 class)
- **`Blocked=decision`** escalation delivery (needs **fresh** fixture per soak2)
- E2E **To do → Done**
- **PIPE-V2-D-SOAK-003** WIP cap semantics with delivery
- **PIPE-V2-D-SOAK-004** doorbell timeout grace
- **PIPE-V2-D-SOAK-005** paused wake (soak3-03 only proves skip, not wake)

---

## Tick plan (suggested)

1. **Dry-run** full board — confirm soak3 rows match expectations; **manual-only** and **paused** show no writes.
2. **`on`** tick — soak3-01 → **In analysis**; expect spec `busy` / doorbell comments.
3. Let spec + review agents work; return to **`dry-run`** between bursts (**SOAK-007** soak3-06).
4. **`on`** again — drive convergence on 01, 04–07; leave 08 until adversarial votes collected.
5. **Stop** when all phase-1 pass criteria met — **do not** launch delivery (no **Ready → In progress** in this phase).

Log run URLs in a future `pipeline-v2-soak3-findings.md` when phase 1 completes.

---

## Shared body rules (all soak3 fixtures)

- Title prefix: `[sandbox] soak3-<NN> …`
- Labels: `task` + `pipeline-beta` (except control rows)
- **Security or Sensitive Area: No** unless the row tests escalation (none in phase 1).
- **Delivery plan** must say phase 1 stops at **Ready** — agents must not open delivery PRs in phase 1.
- HTML comment: `<!-- soak3:expect … -->` per row (in issue bodies).

---

## Findings doc

Create `pipeline-v2-soak3-findings.md` (`status: proposed`) when phase 1 ticks start; fold into `github-issue-workflow.md` when phase 2+ complete.