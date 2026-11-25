---
title: Issue pipeline automation — proposal
owner: Documentation Team
audience: both
status: superseded
last_updated: 2026-11-17
tags: [agent-efficiency, github-issues, automation, security]
---

# Issue pipeline automation — proposal

> **Superseded (2026-11-17).** The pipeline is now the `Stage` state machine in [#2385](https://github.com/AgathaTrack/AgathaTrack/issues/2385), described in [github-issue-workflow.md §Pipeline v2](../github-issue-workflow.md#pipeline-v2-the-stage-machine). This document is kept for the decision history only.


Automate engineering issues from intake through production: **Pawpet** board columns show **stage**, **assignee** shows **whose turn**, and a hidden **state block** holds round count and machine fields. Claude (`pawpet-claude`) and Cursor (`pawpet-bot`) alternate on review; Cursor chooses delivery and implements under a work-in-progress limit; GitHub Actions track release.

**Repository:** [`AgathaTrack/AgathaTrack`](https://github.com/AgathaTrack/AgathaTrack) (org-owned, free plan). **Board:** org Project [**Pawpet**](https://github.com/orgs/AgathaTrack/projects/2).

Grounded in manual Agent1/Agent2 review on 2026-11-13 (#311, #1672, #1770, #2116, #2139, #2175), org migration (#2324, #2328, #2330), and automation already on `main`. **Analysis and target design only** until stacked build PRs land.

**Folds into (on build):** `github-issue-workflow.md`, `github-labels.md`, light-plan skill, execute-plan v2 contracts.

Implementation detail (events, tokens, lanes, locks): [issue-pipeline-dispatcher-spec.md](./issue-pipeline-dispatcher-spec.md).

## Recorded elsewhere

| What | Where | Status |
|------|-------|--------|
| Agent review rounds on the six issues | Issue comments and bodies | Recorded |
| Delivery method per issue | Issue body + `PR` / `light-plan` label | Recorded |
| This proposal (architecture, gaps, decisions) | This file (+ dispatcher spec) | **This PR** |
| Org migration (repo, Pawpet, status values) | `main`: #2324, #2328, #2330, `github-issue-workflow.md` | Live |
| Live triage (`human-reviewed` → Ready) | `triage-human-reviewed.yml`, `github-issue-workflow.md` | Live until dispatcher replaces it |

**Programme status (2026-11-14):**

| Issue | Status |
|-------|--------|
| #2139 | Delivered; closed after UAT validation (`uat-261114-2319`) |
| #1770 | Light-plan paused (`busy`); resume `continue light-plan #1770` on `cursor/ac-coverage-1770-integration-bc17` |
| #2175, #1672, #2116, #311 | Ready + `PR`; not started |

**Collateral to retire after build:** `Agent1:*`, `Agent2:*`, `AgentReview-*`, ad-hoc `Claude Validated` — replaced by assignee handoffs and comments.

---

## Owner decisions

| # | Question | Decision | Log ID |
|---|----------|----------|--------|
| 1 | Who approves execute-plan programmes started by the pipeline? | **(b) Coded auto-approve policy** in the approve workflow, as the bot, under strict conditions (§8). Never an agent posting the approval line with the owner token. | ISSUE-PIPELINE-D-001 |
| 2 | Lifecycle of light-plan issues | **Hybrid:** agent session stops at Pre-UAT green; Actions move In Main → In UAT → In Prod and close (§9). | ISSUE-PIPELINE-D-002 |
| 3 | Repo and Project ownership | **Superseded:** org-owned `AgathaTrack/AgathaTrack`; Pawpet board is the human view of **stage**. Fine-grained repo-scoped PATs and/or a GitHub App with org Projects permission are allowed (§2). | ISSUE-PIPELINE-D-003 → **D-003b** |
| 4 | Review counters in titles | **Hidden state record** in a bot-authored issue comment, not the title or body (§4). | ISSUE-PIPELINE-D-004 |
| 5 | Whose turn | **Assignee** is the single “ball in court” signal: `pawpet-claude`, `pawpet-bot`, `KanopeeKa`, or unassigned (automation / queued). Does not replace board column or state block (§3, §6). | ISSUE-PIPELINE-D-005 |
| 6 | In Analysis vs To do | **No separate "Agent Review" column.** Backlog → **To do** = human (or policy) decision to enter the pipeline. **Assigned** Pawpet collaborator agent = inside automation; **unassigned** To do = outside automation. **In Analysis** = agent peer-review stage. Deterministic triage runs at the **start of To do** (before Claude intake), not as a separate board meaning (§5). | ISSUE-PIPELINE-D-006 |

---

## Owner's original design (2026-11-13) and how it maps

The owner's brief, kept here so the intent is not lost. It set four questions and specified one workflow per status. The target lanes are in [github-issue-workflow.md §Pipeline v2](../github-issue-workflow.md#pipeline-v2-the-stage-machine).

### The four questions

| # | Question | Answer |
|---|----------|--------|
| Q1 | How do Cursor and Claude both get access to workflows, the Project, issues and content? | Two machine users on the org repo: `pawpet-bot` (Cursor) and `pawpet-claude` (Claude), each with a fine-grained PAT scoped to this repo. Each lane gets the least access it needs: analysis lanes read code and write issues; implement and monitor lanes also write code and PRs. Only the dispatcher and release jobs write the Pawpet **Status**, using an org Projects token. Claude therefore no longer needs Projects access itself. The owner token stays out of every autonomous lane (§2). |
| Q2 | One tick per workflow, or a general tick? | **One general dispatcher** that picks a lane per issue (§7), with one concurrency group and cap per lane. Separate per-status ticks would race each other on the same issues. |
| Q3 | How often? | **Event-driven first** (assignment, labels, allowlisted comments, merged PRs, deploy runs), with a **30-minute heartbeat** as the safety net, matching the execute-plan driver. GitHub cron is best-effort, so nothing below about 15 minutes. |
| Q4 | Throttle implementation to one or two issues In progress? | Yes: a **work-in-progress limit of 2**, enforced by the dispatcher rather than the prompt. Each product issue In progress + `pawpet-bot` holds one slot, whatever its delivery method. Stuck work keeps its slot. |

### Workflow by workflow

| Original workflow | Kept | Changed, and why |
|-------------------|------|------------------|
| **Backlog → To do:** `todo` label moves the issue and is then removed; can also be done by hand | Both paths | The move also **assigns `pawpet-claude`**. Assignment is the trigger, and an unassigned issue in To do stays outside automation (D-006). |
| **To do (Claude):** info check → `missing-info`; analysis prompt; detailed comment; `Claude:InitialDone`; → In Analysis; `[0]` title counter | Info check, prompt (verbatim in the workflow doc), detailed comment, move to In Analysis | `missing-info` → the existing **`question`** label, plus assigning the author. `Claude:InitialDone` → **assign `pawpet-bot`**. The title counter → `round` in the state comment, because title prefixes break `isPlanControlIssue` and humans edit titles (D-004). Deterministic form triage runs first (D-006). |
| **Analysis 1/2/3** (Cursor ⇄ Claude; Green → Ready, Red → stay; stale-label clean-up; counter > 5 → `needs-owner`) | Alternating review, fold minor points into the issue, one clear comment, Green/Red verdict, `needs-owner` on no convergence | The three workflows are one mirrored step, so they become **one review lane**. The reviewer is whichever agent is assigned. The verdict is the **reassignment**, so no verdict labels and no stale-label rules are needed (D-005). **Convergence:** under the original rule, one agent could fold the other's points into the body *and* go Green → Ready in the same step, so the other agent never saw the edited text. Ready therefore needs a Green whose reviewer made no substantive body change, so the body that goes to Ready is one the other agent already reviewed. **Limit:** `round >= 6` by default instead of > 5, to cap token cost; configurable. |
| **Ready 1 — delivery method** (Cursor): PR / light-plan / execute-plan; rewrite the existing issue to the template; restricted files → `needs-owner`; add the method label | All of it | It runs while `pawpet-bot` is assigned in Ready, then unassigns, which queues the issue. Planned paths go in an `agent-paths` block. The dispatcher, not the agent, decides sensitivity, fail-closed against expanded globs (§10). |
| **Ready 2 — implement** (Cursor, Composer 2.5): PR → `/babysit-plus`; light-plan → `/light-plan`; execute-plan → `/run-as-me` + post `approve-autonomous`; started → In progress, else `needs-owner` | PR and light-plan paths, start check, Composer 2.5, `needs-owner` on a failed launch | **Throttled** (Q4). **execute-plan:** an agent posting `approve-autonomous` with the owner token is forbidden (`run-as-me` skill rule 6) and would let issue text drive autonomous merges. It is replaced by the coded auto-approve policy run as the bot (D-001). |
| **In progress** (Cursor): second title counter, > 5 → `needs-owner`; PR merged → In Main; relaunch babysit if nothing is watching; restart halted plans without a human | Relaunch-if-ended, `needs-owner` on repeated relaunches | Second counter → `stuck` in the state comment; limit 3 by default, configurable. "Is babysit watching?" is decided from the recorded run's status through the Cursor API, not guessed. PR merged → In Main is **already done by Actions**. **light-plan:** relaunch with `continue light-plan #n`; the session drives its own release through `/babysit-uat`. **execute-plan:** report only. Resuming a stopped plan is owner-only, and pushing to plan branches outside a worker `tick` is forbidden. |
| **In Main** (Cursor or GitHub): find the UAT deploy containing the merge; is it findable automatically? | Moved by automation | **Yes, it can be found:** `promote-uat` tags `uat-YYMMDD-<PR#>`, the PR body has `Refs #n`, and `deploy-uat.yml` already sets **In UAT**. No note on the issue is needed. |
| **In UAT** (Cursor or GitHub): find the prod deploy → `In prod` label; then tidy up and close | Tidy-up and close | A **prod notify job** in `deploy-prod.yml` sets **Done** and closes the issue, but only after a real production deploy plus smoke, never on the stub path. The `in-prod` label is optional and non-authoritative. |

---

## 1. What already exists on `main`

Extend these; do not duplicate.

| Piece | Location | Today |
|-------|----------|--------|
| Deterministic triage | `triage-human-reviewed.yml`, `triage-lib.js` | On `human-reviewed`: form checks → **Ready** + `agent-approved` or Backlog / `manual-only` |
| Cursor dispatch | `agent-dispatch.yml` | Single-threaded Ready + `agent-approved` + `human-reviewed` |
| Payload / safety | `agent-payload-lib.js`, `agent-safety-lib.js` | Sanitised prompts; forbidden paths |
| Monitor | `agent-monitor.yml` | Polls run marker (manual dispatch) |
| Merge → In Main | `issue-agent-pr-merge.yml`, `issue-agent-handlers.js` | Merged `cursor/**` + `Refs #n`; skips plan control issues |
| UAT | `promote-uat.yml`, `deploy-uat.yml` | Tag, deploy, **In UAT** notify |
| Prod | `deploy-prod.yml` | Deploy only — **no issue notify** |
| Execute-plan v2 | `execute-plan-approve.yml`, driver cron | Owner/MEMBER approve; `EXECUTE_PLAN_DRIVER` kill switch |

**Constraint (unchanged):** GitHub Actions cannot trigger on Project v2 status changes (`projects_v2_item` is webhook-only). Something Actions *can* trigger on must drive the pipeline: **assignment**, labels, or comments. The board stays the display, synced by automation.

### 1.1 Current setup by Pawpet status

| Status | What moves issues today | Agent |
|--------|-------------------------|-------|
| Backlog | Issue forms; triage / pipeline intake failures | — |
| To do | Manual; `issue-pipeline-todo.yml` on `todo`; pipeline intake when assigned `pawpet-claude` (`pipeline-beta` / `ISSUE_PIPELINE=on`) | Claude stub |
| In Analysis | Legacy: `human-reviewed` → triage. Pipeline: dispatcher review lane | Bot stubs |
| Ready | Legacy dispatch **or** pipeline delivery + queued implement | Cursor |
| In progress | Legacy monitor **or** pipeline implement + monitor | Cursor |
| In Main | `issue-agent-pr-merge.yml` | — |
| In UAT | `deploy-uat.yml` notify | — |
| Done | Prod notify on board **In UAT** (repair P5) or manual | — |
| Prod (deploy) | `deploy-prod.yml` | Feeds prod notify |

---

## 2. Access and identities (post–org migration)

| Actor | Login | Token notes |
|-------|-------|-------------|
| Cursor workers | `pawpet-bot` | Classic or **fine-grained PAT** scoped to this repo; pushes/PRs via Cursor GitHub App |
| Claude workers | `pawpet-claude` | Fine-grained PAT or `claude-code-action` with workflow token where sufficient |
| Dispatcher / board sync | Bot PAT(s) with **org Project** read/write | `GH_PROJECTS_PAT` or fine-grained + Projects; not on every Cloud VM |
| Owner escalation | `KanopeeKa` | Assignment + `needs-owner`; execute-plan approve accepts MEMBER + owner login (#2324) |
| Deterministic steps | `GITHUB_TOKEN` | Cannot chain-trigger other workflows — handoffs use bot PAT (§6.4) |

**Token hygiene:** Narrow `OWNER_GH_TOKEN` off default Cloud VMs; prefer repo-scoped fine-grained tokens now that the repo is org-owned. No agent token gets `workflow` scope.

---

## 3. Target model: three visible signals

| Signal | Role | Values |
|--------|------|--------|
| **Board column (Pawpet Status)** | Stage in the lifecycle | Backlog, To do, In Analysis, Ready, In progress, In Main, In UAT, Done (+ Prod tracking via notify) |
| **Assignee** | Whose turn | `pawpet-claude`, `pawpet-bot`, `KanopeeKa`, or *nobody* (queued / Actions-only stages) |
| **Delivery label** | How to implement | `PR`, `light-plan`, `execute-plan` (on **Ready** after delivery step) |

Plus **hidden state block** (§4): `round`, `body_sha`, `owner_reason`, `delivery`, run ids.

**Retire** verdict labels (`Claude:*`, `Cursor:*`, `review:*`) when assignee handoffs land: Green with edits or Red → reassign to the other agent; Green with no substantive body change → advance column and unassign.

**Keep** `needs-owner` **label** for execute-plan driver STOP compatibility; mirror reason in the state block.

---

## 4. Hidden state block

Do not use title counters — they break `isPlanControlIssue` and human edits.

**Normative storage:** one dedicated comment per issue with `<!-- pipeline-state -->` plus the JSON marker (lane comments do not embed state). Writes use the Pawpet bot token so the author is `pawpet-bot` or `pawpet-claude`. Loaders ignore markers on comments from other authors or edited by someone other than the author (`scripts/lib/pipeline_state_trust.js`).

```html
<!-- agent-state: {"round":3,"stuck":0,"last_assignee":"pawpet-claude","body_sha":"…","delivery":"PR","owner_reason":null,"run_id":null,"verdicts":{"pawpet-claude":"green","pawpet-bot":"green"},"converged_at":"2026-11-14T12:00:00Z"} -->
```

| Field | Meaning |
|-------|---------|
| `round` | Completed peer-review rounds; **stop when `round >= 6`** (default cap; configurable). Owner-driven reopen resets `round` to 0 |
| `stuck` | Monitor light-plan relaunches while In progress. A lifetime cap (`PIPELINE_STUCK_MAX`, default 3): never reset on progress. A run whose final message holds `owner decision` is a stop, not a cut-off, and is not relaunched |
| `last_assignee` | Previous ball-holder; dispatcher enforces handoff ≠ same agent on review |
| `body_sha` | Hash at last verdict; convergence when Green and unchanged |
| `verdicts` | Last **per-agent** verdict (`green` / `red`) for the current `body_sha`; **cleared on reopen** so stale Greens cannot satisfy convergence |
| `converged_at` | ISO timestamp when both agents recorded `green` on the same `body_sha` |
| `delivery` | Set at delivery step |
| `owner_reason` | With `needs-owner`: `sensitive-paths`, `no-convergence`, `stuck`, `launch-failed`, `plan-stopped`, `approve`, … |
| `run_id` | Cursor/Claude run correlation |

Ignore markers not on a comment whose author is `pawpet-bot` or `pawpet-claude`.

---

## 5. Target setup by status and assignee

| Pawpet status | Assignee (whose turn) | Step |
|---------------|----------------------|------|
| Backlog | — | Intake from forms; triage may return here |
| To do | `pawpet-claude` (when in pipeline) | **Gate:** issue must be assigned to a Pawpet agent collaborator to enter automation. **Triage** (deterministic, no LLM) at lane start — successor to today’s `human-reviewed` gate. Then Claude intake: enough information? Plan sketch. Insufficient → `question`, assign author/owner |
| In Analysis | Alternate `pawpet-bot` ⇄ `pawpet-claude` | Peer review. Red, or Green with edits → other agent. Green, no substantive body change → **Ready**, assign `pawpet-bot` for delivery. Round limit → assign `KanopeeKa`, `needs-owner` |
| Ready (no delivery label) | `pawpet-bot` | Delivery: method, template, planned paths block; sensitive paths → owner |
| Ready (+ `PR` \| `light-plan` \| `execute-plan`) | *Unassigned* | Queued until WIP slot free |
| In progress | `pawpet-bot` | Implement or monitor (light-plan `continue`; execute-plan report-only) |
| In Main → In UAT → In Prod → Done | *Unassigned* | Existing merge/UAT handlers + **new prod notify** (§5.7) |
| Any | `KanopeeKa` | `needs-owner` + reason in state block |

**Human workflow:** Moving Backlog → To do and assigning an agent is the explicit “go”. Unassigned To do items are visible but **not** picked up by the dispatcher.

### 5.1–5.6 Lane behaviour (summary)

Step-by-step lanes (intake, peer review, delivery, implement, monitor, release, needs-owner) and the handoff table live in [github-issue-workflow.md §Pipeline v2](../github-issue-workflow.md#pipeline-v2-the-stage-machine). Compared with the 2026-11-13 draft:

- **Status moves** use Pawpet **Status** field (bot PAT), not `status:*` labels. The Stage ↔ Status mirror was cancelled ([#2345](https://github.com/AgathaTrack/AgathaTrack/issues/2345)); see ISSUE-PIPELINE-D-010.
- **Handoffs** use **assignment** with the agent’s PAT, not verdict labels.
- **Planned** is not a board column: delivery runs in **Ready** while `pawpet-bot` is assignee before the delivery label is applied.

Convergence (In Analysis → Ready): Green **and** `body_sha` unchanged in that round (the body is the one the previous agent handed over). Green with a substantive edit — even after an earlier Green — reassigns to the other agent. Round cap **6** — escalate when `round >= 6` (configurable).

**Reopening:** if `body_sha` changes after `converged_at`, strip delivery labels, reset `verdicts`, clear `converged_at`, return to **In Analysis**, and assign the other agent (or `needs-owner` if already at round cap). Two fresh Greens required on the new hash. Dispatcher row **3a** and implement row **5** guards. Full table: [github-issue-workflow.md §Pipeline v2](../github-issue-workflow.md#pipeline-v2-the-stage-machine).

Work-in-progress (implement): **2** slots — e.g. one programme + one single PR, or two single PRs. Each product issue **In progress** assigned `pawpet-bot` (with `busy` or an active programme) holds one slot, whatever its delivery method. See dispatcher spec §5.

### 5.7 Release tracking (Actions only)

- **In Main / In UAT:** unchanged until migration consolidates Project status writers (§7).
- **In Prod (new):** notify job in `deploy-prod.yml` mirroring `agent-uat-notify`, but **only when production actually deployed** — not on `deploy-prod` success with `PROD_DEPLOY_ENABLED=false` / stub-skip paths. Gate on a successful production deploy job plus post-deploy smoke (same bar as human prod promotion). Then set Pawpet **Done** (board column; no `status:*` label), tidy `busy`, close the issue. Optional audit label `in-prod` is non-authoritative.

---

## 6. Assignee model

**Verdict:** adopt assignee as the single “whose turn” signal (ISSUE-PIPELINE-D-005).

| Benefit | Why |
|---------|-----|
| Works today | Both bots are collaborators on the org repo |
| Native trigger | `issues: assigned` is an Actions event |
| Simple queues | Each agent queries `assignee:@me` |
| Board visibility | Pawpet already shows assignees |
| Review independence | Handoff to the other login ⇒ never self-review |
| Fewer labels | Replaces `Claude:*` / `Cursor:*` / round verdict labels |

**Pitfalls to design for:**

1. **`GITHUB_TOKEN` reassignment does not chain workflows** — handoffs use `pawpet-bot` or `pawpet-claude` PAT, or explicit `workflow_dispatch`; 30-minute heartbeat is the safety net.
2. **Exactly one assignee** — dispatcher enforces; workers exit if assignee changed before write.
3. **Column ≠ assignee** — same agent may be assignee in To do vs In Analysis; column disambiguates.
4. **`needs-owner` stays a label** — driver reads label, not assignment alone.
5. **Human reassignment** is allowed; dispatcher logs a comment and follows the new assignee.
6. **WIP count:** one slot per product issue In progress + `pawpet-bot` (with `busy` or an active programme).

---

## 7. Architecture

One **dispatcher** (`issue-pipeline-dispatcher.yml` + `scripts/issue_pipeline_dispatcher.js`), patterned on `execute_plan_runtime.js tick`:

- Reads board status, assignee, labels, state block, PRs, CI, Cursor runs.
- **One action per issue per tick**; launches a narrow worker (Claude action or Cursor API).
- Lanes: triage (deterministic), intake, review, delivery, implement, monitor, release (no agent).
- Kill switch repo variable `ISSUE_PIPELINE`: `off` (default) / `dry-run` / `on`.
- Consolidate `triage-human-reviewed.yml`, `agent-dispatch.yml`, `agent-monitor.yml` when lanes go live.
- **Stage / Status writes (current on `main`):** merge, UAT, and prod handlers in `issue-agent-handlers.js` set the org **`Stage`** field (`setIssueStage` / `writeIssueFields`), not the Pawpet project **Status** column. Agents must not write project Status. When the repo variable `STAGE_MIRROR` is `on`, `scripts/stage_mirror.js` mirrors org `Stage` ↔ project **Status** via `updateProjectStatus` (`github-project-lib.js`). A future dispatcher must keep a single writer per transition and not revive direct Status writes from the legacy handler path.

Full contract: [issue-pipeline-dispatcher-spec.md](./issue-pipeline-dispatcher-spec.md).

---

## 8. Execute-plan (decision 1b)

- **Product issue** stays in the pipeline; **control issue** for the driver; snapshot `source_issue`; release PR `Refs #<product>`.
- **Auto-approve** in `execute-plan-approve.js` only when policy checks pass:
  - **Paths:** expand phase `allowed_paths` globs against tracked files; forbidden match → fail (not raw string compare on `agent-paths` alone).
  - **Provenance:** `-init` branch contains only plan files **and** init commits are authored by `pawpet-bot` (branch tip committer / signed bot provenance — not file-set check alone).
  - **Convergence:** product issue state comment shows `verdicts` with both bots `green` and matching `body_sha` / `converged_at`.
  - Budgets, single active plan, `EXECUTE_PLAN_DRIVER` on.
- **Auto-approve rejection:** set `needs-owner` on the **product** issue **and** remove `autonomous-approved` / add stop signal on the **control** issue so the driver cannot launch workers (execute-plan driver STOP).
- Escalation: owner review on approval code; decision rows in `execute-plan-v2.md` and `contracts.md`.

---

## 9. Light-plan lifecycle (decision 2)

| Change | Detail |
|--------|--------|
| Release PR | `Refs #n` not `Closes #n` |
| Session end | Pre-UAT green → remove `busy`, do not close issue |
| `issue-agent-handlers.js` | In Main for `light-plan:` titles; still skip execute-plan control only |
| Prod notify | §5.7 |

---

## 10. Security

- **Prompt injection:** Treat **issue body and state marker as untrusted quoted data** in intake/review prompts (not only comments). Allowlist comment authors (`KanopeeKa`, `pawpet-bot`, `pawpet-claude`); wrap as quoted blocks, never as instructions. Implement lane keeps `agent-payload-lib.js` (structured form sections only).
- **Owner token:** never in autonomous lanes.
- **Review independence:** assignee on review lane must differ from `last_assignee` in state block.
- **Sensitive paths:** The delivery agent's `agent-paths` JSON block is **advisory**. The dispatcher **fail-closes** before implement/approve: expand globs against the repo file tree, run `isForbiddenPath` on every match, reject intersecting `.github/**` and `.cursor/agent-kernel/**`, and reject missing/invalid blocks. Pre-launch, re-check the open PR diff against the same rules (agents must not omit protected paths from the block to bypass the gate).

---

## 11. Gaps (build backlog)

| # | Gap | Size | Notes |
|---|-----|------|-------|
| 1 | Proposal on `main` | Docs | Merge this PR after review |
| 2 | In Analysis dual meaning until triage moves | Decision | **D-006** — triage at To do start |
| 3 | No dispatcher | Large | Skeleton dry-run → lanes |
| 4 | No Claude runner | Medium | `claude-code-action` or agreed runner + `pawpet-claude` token |
| 5 | Delivery not automated | Medium | Ready + `pawpet-bot` assignee |
| 6 | No WIP limit; dispatch ignores programme load | Medium | Fold dispatch + monitor into dispatcher |
| 7 | No prod notify | Small | `deploy-prod.yml` |
| 8 | Light-plan `Closes` + `isPlanControlIssue` skip | Small | **D-002** |
| 9 | Execute-plan auto-approve + `source_issue` | Medium | **D-001** |
| 10 | Label clutter | Small | Retire after assignee model |
| 11 | Tokens on Cloud VMs | Small | Fine-grained repo PATs |
| 12 | #1770 paused | Ops | `continue light-plan #1770` |

---

## 12. Delivery order (stacked PRs)

One verifiable outcome per PR.

1. **Docs:** merge this proposal (and align `github-issue-workflow.md` in a follow-up when behaviour ships).
2. **Small / independent:** prod notify; light-plan lifecycle (§9).
3. **Dispatcher skeleton:** kill switch, dry-run, state block, assignee + column sync, lock — no workers.
4. **To do lane:** deterministic triage at To do + Claude intake + assignment handoffs.
5. **In Analysis lane:** alternating review + convergence.
6. **Delivery lane:** templates, paths block, sensitive-path gate.
7. **Implement + monitor:** WIP limit; retire legacy dispatch/monitor/triage workflows.
8. **Execute-plan:** auto-approve + `source_issue` (owner review).

**Operational:** resume #1770 before or in parallel with pipeline build — not blocked on dispatcher.

---

## 13. End-to-end flow (target)

```
Backlog
  │ human/policy: To do + assign pawpet-claude
  ▼
To do ──[deterministic triage]──▶ (fail → Backlog / manual-only)
  │ pass ──[Claude intake]──▶ In Analysis (assign other agent)
  ▼
In Analysis ⇄ bot/claude peer review (assignee alternates)
  │ converged ──▶ Ready, assign pawpet-bot
  ▼
Ready ──[delivery]──▶ Ready + PR|light-plan|execute-plan, unassign
  │ sensitive / approve fail ──▶ KanopeeKa + needs-owner
  ▼
Ready (queued) ──[implement, WIP]──▶ In progress, pawpet-bot, busy
In progress ──[monitor]──▶ …
merge (Actions) ──▶ In Main ──▶ In UAT ──▶ In Prod notify ──▶ Done + close
```

---

## Decision log

| ID | Decision | Rationale | Status | Date |
|----|----------|-----------|--------|------|
| ISSUE-PIPELINE-D-001 | Coded auto-approve for pipeline-started execute-plan | Trusted state + path gate (Step 1); bot `approve-autonomous` stays suspended until dispatcher writes `execute_plan_launch` (issue repair 4.5) | In delivery | 2026-11-16 |
| ISSUE-PIPELINE-D-002 | Light-plan issues follow In Main → UAT → Prod via Actions | One lifecycle; agent stops at Pre-UAT green | Live | 2026-11-15 |
| ISSUE-PIPELINE-D-003 | ~~User-owned; status labels source of truth~~ | — | **Superseded** | 2026-11-13 |
| ISSUE-PIPELINE-D-003b | Org-owned repo; Pawpet **column** = stage; org-scoped token may sync board | Org migration #2324+; Claude/Cursor can read/write Status | Proposed | 2026-11-14 |
| ISSUE-PIPELINE-D-004 | State in dedicated `<!-- pipeline-state -->` comment (bot PAT; newest `updated_at` wins) | Title prefixes break plan control detection; lane comments no longer embed JSON | **Live** (integration) | 2026-11-16 |
| ISSUE-PIPELINE-D-005 | **Assignee** = whose turn; handoffs replace verdict labels | Native trigger, board visibility, review independence | Proposed | 2026-11-14 |
| ISSUE-PIPELINE-D-006 | To do + agent assignee = pipeline entry; In Analysis = peer review; triage at To do start | Backlog→To do is human go; no extra board column | Proposed | 2026-11-14 |
| ISSUE-PIPELINE-D-007 | Owner body edit during In Analysis / Ready reopen | GraphQL `userContentEdits` round reset deferred; column-scoped reopen + trust allowlist shipped (repair #2363 §3.3) | **In delivery** (partial) | 2026-11-16 |
| ISSUE-PIPELINE-D-008 | `agent-paths` gate applies in delivery **and** implement lanes | Review rounds do not re-expand paths; fail-closed before label + before launch (repair #2363 §4.2) | **Live** (integration) | 2026-11-16 |
| ISSUE-PIPELINE-D-009 | **Stage** org issue field mirrors board **Status** (two-way, board wins on conflict); no `status:*` labels | Step 0: board stays on built-in Status; mirror ([#2345](https://github.com/AgathaTrack/AgathaTrack/issues/2345)) | **Superseded** by ISSUE-PIPELINE-D-010 | 2026-11-16 |
| ISSUE-PIPELINE-D-010 | No Stage ↔ Status mirror; the org `Stage` field is pipeline state, not a copy of the board column | Owner cancelled the mirror on [#2345](https://github.com/AgathaTrack/AgathaTrack/issues/2345). Workflow, scripts and tests removed; Projects `Synced stage` fields, `STAGE_MIRROR` and mirror secrets retired on the owner side | **Live** | 2026-11-25 |

---

## 6. Owner soak (post-repair)

After integration merges (#2363), production cutover is **owner-operated** — agents document; they do not flip repo variables on live traffic without instruction.

| Step | Owner action | Success signal |
|------|--------------|----------------|
| 1 | Set `ISSUE_PIPELINE` to `dry-run` | Dispatcher logs planned actions; legacy dispatch unchanged |
| 2 | Tag one or two sandbox issues with `pipeline-beta`; set `ISSUE_PIPELINE=on` only after reviewing dry-run logs | Board handoffs on beta issues only |
| 3 | Watch **Actions → Issue pipeline dispatcher → schedule** runs | Each run logs `pipeline_health`; staleness warning if gap > 2h since last completed schedule |
| 4 | Fix open repair debt (#2337, #2345, #2342) before widening beta | No `needs-owner` surprises on programme issues |
| 5 | Remove `pipeline-beta` gate and leave `ISSUE_PIPELINE=on` | Legacy triage/dispatch workflows skip (spec §14.3) |

Scheduled ticks use cron `7,37 * * * *` (off the half-hour). Missing heartbeats surface in `pipeline_health.schedule.stale`.
