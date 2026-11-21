---
title: Pipeline v2 soak2 findings
owner: Agent efficiency
audience: owner
status: in-delivery
last_updated: 2026-11-21
tags: [agent, pipeline, soak]
related_prs: [2509, 2510, 2511, 2512]
---

# Soak2 findings and remediation (2026-11-21)

**Proposal / in-delivery** — live tick outcome table for soak2. Canonical decisions: [`github-issue-workflow.md`](../github-issue-workflow.md) (PIPE-V2-D-SOAK-006–008, PIPE-V2-D-PREFLIGHT-001, PIPE-V2-D-RUNNER-001). Fixture matrix: [`pipeline-v2-soak2-matrix.md`](./pipeline-v2-soak2-matrix.md) (**PR #2509**).

**Live windows**

| Window | `ISSUE_PIPELINE_V2` | Runs |
|--------|---------------------|------|
| Initial soak | `on` ~16:44–17:01 UTC, then `dry-run` | [44926171197](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44926171197) · [44926895355](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44926895355) · [44927399610](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44927399610) |
| Post-#2510/#2511/#2512 resume | `on` ~21:27–22:05 UTC, then **`dry-run`** (22:06 UTC) | [44951660909](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44951660909) · [44952597885](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44952597885) · [44954818042](https://github.com/AgathaTrack/AgathaTrack/actions/runs/44954818042) |

---

## Outcome matrix (expectation vs reality)

| # | Fixture | Expected | Observed | Root cause | Fix |
|---|---------|----------|----------|------------|-----|
| — | Round robin (#2510) | Board-wide rotation | **#2497** Claude **In progress**; many **claude-a** doorbells on board in tick 3 | #2510 merged | **Pass** — optional re-check in next `on` window |
| #2494 | Question | Skip | **`blocked`** | — | **Pass** |
| #2496 | Paused | Skip | **`blocked.paused`** | — | **Pass** |
| #2503 | manual-only | No writes | **`manual-only`** | — | **Pass** |
| #2495 | Decision / SOAK-008 | **`Blocked=decision`**, no launch until owner clears | Pre-reset: converged **Ready**, **launch:cursor-a** (tick 2). Owner reset **In analysis** + **`Blocked=decision`** → tick 3 **`blocked`** (no launch) | Review edited Security to evade keywords; engine does not infer **`Blocked=decision`** from plan text alone | **#2511** skills; operator restored truthful **Security or Sensitive Area: Yes** and cleared **`Blocked`** (2026-11-21). Re-test escalation on next `on` slice |
| #2493 | E2E → Done | Full stage path | **In analysis**, rotation continues | Time / WIP; not converged yet | **Deferred** (owner: wait) |
| #2497 | Claude runner | claude-a path → delivery | **In progress** (claude assignee) after **`ready.launched`** tick 3 | — | **Pass** (in flight) |
| #2505 | Ready launch | Delivery | **`ready.launched`** → **In progress** tick 3 | — | **Pass** (in flight) |
| #2498/#2508 | Converge + launch | Docs PR | **Ready**; **`launch-failed`**: `migrations` | `detectRiskyScope` scanned whole body | **PIPE-V2-D-PREFLIGHT-001** (Out of scope excluded) |
| #2507/#2499 | Stalled wake + launch | **Ready** → typo PR | **Ready** (SOAK-007); **`launch-failed`**: auth/billing/infra/migrations | Exclusion lists in **Out of scope** tripped whole-body scan | **PIPE-V2-D-PREFLIGHT-001** |
| #2506 | Bug DoR delivery | Docs PR | **Ready**; **`launch-failed`**: auth/billing in **Acceptance criteria** prose | Keywords in in-scope section (not Out of scope heading) | Operator reworded acceptance line on issue (2026-11-21) |
| #2504 | Sensitive probe | Refuse launch | **`launch-failed`**: secrets + Security **Yes** | Intentional fixture | **Pass** (gate works) |
| #2500 | Late branch | Reassign / blocked paths | **`analysis.reassign`** claude-a | Scripted soak | In progress |
| #2501/#2502 | WIP queued | Queue when cap | **`analysis.waiting-busy`** | #2493 not **In progress** | Wait on #2493 or WIP |
| #2512 | Runner WIP / queued | Cap + **`queued`** label | Launches when **`wip":0`**; backoff on failed preflight | Observed in resume window | **Pass**; follow **#2513/#2514** debt |
| — | Matrix #2509 | On `main` | Branch policy | — | Merge when allowed |

---

## #2495 launch-safety bypass (SOAK-008)

Agents must not edit **Security or Sensitive Area** (or scope prose) to evade `preflightIssue`. Use **`Blocked=decision`** and keep the body truthful. Spec/review SKILL gates shipped in **#2511**; full re-validation needs a live tick with cleared **`Blocked`** and honest Security text.

---

## Remediation shipped / queued

| Item | Status |
|------|--------|
| **#2510** round robin | Merged |
| **#2511** SOAK-007/008 docs + spec/review skills | Merged |
| **#2512** Claude runner WIP + **`queued`** | Merged |
| **PIPE-V2-D-PREFLIGHT-001** — Out of scope excluded from keyword scan | PR in flight (preflight fix) |
| **#2495** body + **`Blocked`** operator reset | Done on issue (2026-11-21) |
| **#2506** acceptance-criteria wording | Done on issue (2026-11-21) |

---

## Recommended next soak steps

1. Merge preflight PR; confirm #2507/#2498/#2508/#2499 pass local `preflightIssue` on current bodies.
2. Short **`on`** window if you want #2495 escalation path + #2493 progress (owner deferred full E2E).
3. Merge **#2509** matrix when branch policy allows.
4. Fold this doc into `github-issue-workflow.md` §Soak2 when signed off.