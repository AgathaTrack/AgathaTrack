---
title: GitHub issue workflow — operations
owner: Documentation Team
audience: both
status: active
last_updated: 2026-11-26
tags: [documentation, github-issues, automation, pipeline-v2]
---
# Issue pipeline — operations

Switches, preview and dry-run, enablement, migration, soak, and day-to-day observation. Entry point: [github-issue-workflow.md](./github-issue-workflow.md). Behaviour: [github-issue-workflow-behaviour.md](./github-issue-workflow-behaviour.md). Wire contract: [github-issue-workflow-wire.md](./github-issue-workflow-wire.md).

### Switches and identity

#### Pipeline switches (reference)

One table for every pipeline-related repo variable and JSON limit that used to be scattered across plan docs (#2560 P4). **Cutover** means moving live board writes to pipeline v2 (`ISSUE_PIPELINE_V2=on` with an empty soak label).

| Switch | Where | Read by (on `main`) | Values | Effect by combination |
|--------|-------|---------------------|--------|------------------------|
| `ISSUE_PIPELINE` | repo variable (retired) | **Nothing** — safe to delete on GitHub | was `off` / `dry-run` / `on` | v1 assignee dispatcher removed ([#2598](https://github.com/AgathaTrack/AgathaTrack/issues/2598)); history in [plans/issue-pipeline-automation.md](./plans/issue-pipeline-automation.md). Never the cutover switch. |
| `ISSUE_PIPELINE_V2` | repo variable | [`issue-pipeline-v2.yml`](../../.github/workflows/issue-pipeline-v2.yml) gate and tick; merge/UAT/prod handlers; `agent-dispatch` / `agent-monitor` / `triage-human-reviewed` job guards; `issue_pipeline_v2.js` | `off` (default), `dry-run`, `on` | `off`: no v2 jobs. `dry-run`: decide + log only. `on`: live writes when `ENGINE_PAT` matches `engine.logins`. Legacy label workflows skip when `on`. |
| `ISSUE_PIPELINE_V2_LABEL` | repo variable | Same as `ISSUE_PIPELINE_V2` | e.g. `pipeline-beta`, `soak4`, or empty | With `on`: only labelled issues get live writes; others stay dry-run on the same tick. Empty = whole board. |
| `WIP_LIMIT` | repo variable | `issue_pipeline_v2.js` | `off` or unset | `off` lifts the Ready queue cap (`limits.wip`) for the run. Any other value keeps the JSON limit. |
| `limits.wip` | `.github/pipeline-agents.json` | `issue_pipeline_v2.js` | positive integer (default 2) | Delivery slot count while `WIP_LIMIT` is not `off`. Not the Stage column. |
| `STAGE_MIRROR` | repo variable (retired) | **Nothing** | was `on` / `off` | Org `Stage` ↔ board `Status` mirror cancelled ([#2345](https://github.com/AgathaTrack/AgathaTrack/issues/2345)). |
| `WIP_MAX` | repo variable (retired) | **Nothing** | was `2` default on v1 | v1 dispatcher only. |
| `PIPELINE_IMPLEMENT_LAUNCH` | repo variable (retired) | **Nothing** | was `true` / unset | v1 implement lane only. |
| `PIPELINE_STUCK_MAX` | repo variable (retired) | **Nothing** | was `3` default on v1 | v1 monitor relaunch cap only. |

**Typical combinations**

| `ISSUE_PIPELINE_V2` | `ISSUE_PIPELINE_V2_LABEL` | What runs |
|---------------------|---------------------------|-----------|
| `off` | any | Legacy label flow (until #2411 removes it); handlers use legacy `Stage` rules; v2 workflow skipped. |
| `dry-run` | e.g. `soak4` | v2 ticks decide and log; scoped issues show what *would* be written; legacy flows still run. |
| `on` | set | Live v2 writes on labelled issues only; legacy dispatch/triage/monitor skipped; handlers skip v2-owned issues. |
| `on` | empty | Full board cutover: v2 owns all issues in scope; legacy flows off. |

#### Identity and pool (`pipeline-agents.json`)

| Setting | Where | Meaning |
|---------|-------|---------|
| `engine.logins` | `.github/pipeline-agents.json` | The account(s) the engine writes as (`pawpet-engine`, secret `ENGINE_PAT` / `GH_PROJECTS_PAT` on the v2 tick). It is never a listed agent. With no matching token the tick runs as a dry run whatever the variable says. |
| `agents`, `limits`, `launchRunners`, `aat` | `.github/pipeline-agents.json` | Pool members: each entry has a logical **`id`** (rotation, timeouts, markers), an **`actsAs`** GitHub login (assignee, `@mention`, reactions), optional **`model`**, **`runner`**, and **`methods`**. Legacy rows with **`login` only** use that login as both `id` and `actsAs`. `engine.logins` must not match any `actsAs`. Limits and `launchRunners` as before. `aat` is `enabled` (boolean; true in this repo), `timeoutMin`, and `maxInconclusive`. A bad edit fails in CI. |

The workflow [`issue-pipeline-v2.yml`](../../.github/workflows/issue-pipeline-v2.yml) ticks the **whole board** when something relevant happens: issue edit, label, close, or reopen; a trusted issue comment (owner, member, collaborator, or configured agent login — not the engine account); a PR merged to `main`; a successful UAT or production deploy; or a finished Claude pipeline runner. Each event passes through `scripts/issue_pipeline_v2_event_wake.js` before the tick job runs; the :11 and :41 schedule is a **sweeper** for missed events (PIPE-V2-HT-R-003, #2560 P3). Manual dispatch also starts the workflow; it **previews by default**: a dry run even when the repo `ISSUE_PIPELINE_V2` is `on`. Both the gate and tick jobs skip while the switch is `off`. It writes only when the `live` input is ticked and the switch is `on`. The `issue_number` input is empty for the whole board or one positive integer; any other value is refused before the board is read. The optional **`mission`** input scopes stage rows for agent-woken runs: `board` (default, full pipeline) or `analyse` (To do through convergence to **Ready** only — requires `issue_number`, never `ready.launch`). Agents wake the engine with `node scripts/issue_pipeline_wake.js --issue <n> --mission analyse --live`. Full spec: [changes/analyse-issue-skill.md](./changes/analyse-issue-skill.md). Each run logs effective mode, target, and mission (`pipeline_v2_run`) before any write (#2553 P4).
Each issue gets one action per tick, logged as a `pipeline_v2_action` line. Every tick ends with one **`pipeline_v2_tick_summary`** line (`runId`, mode, target, mission, `boardReadComplete`, decision/effect/deferral/error counts, `durationMs`). A failed issue read does not abort other issues; `readFailures` marks a partial board read (#2556 P2). GitHub **blocked by** relationships (`blockedBy` GraphQL) skip stage writes and handoffs while any blocker is open (`pipeline_v2_skip` / row `blocked-by`; #2556 P3).

**`/analyse-issue`:** Cursor skill [`.cursor/skills/analyse-issue/SKILL.md`](../../.cursor/skills/analyse-issue/SKILL.md) — engine-first spec and review until **Ready**, without delivery. Orchestrator may set **`Stage` = To do** at intake only (PIPE-V2-D-ANALYSE-003); lane agents still do not write `Stage`.
### Operating it

- **Lifting the WIP cap:** `WIP_LIMIT=off` (see the switches table) only changes the Ready gate. In `on` mode it still
  writes only to issues matching `ISSUE_PIPELINE_V2_LABEL`, but with the cap off every matching Ready issue launches on
  the next tick. Set it back or remove it when the soak is done.
- **Dry run:** set `ISSUE_PIPELINE_V2=dry-run`, or dispatch the workflow without `live` (a manual dispatch previews by default, so an operator following these steps cannot write while scheduled ticks are live), and read the `pipeline_v2_action` lines and the
  tick summary. Check that nothing acts on hand-driven issues (label them `manual-only`).
- **Migration (once):** dispatch [`issue-pipeline-v2-migrate.yml`](/.github/workflows/issue-pipeline-v2-migrate.yml)
  as a dry run, read the `pipeline_v2_migrate` lines, then dispatch with `apply`. It gives each open board issue a `Stage`
  (from the board column, else Backlog) and a `Blocked` reason from the legacy `question` / `needs-owner` labels.
- **Soak:** `dry-run` for a day; then `on` with `ISSUE_PIPELINE_V2_LABEL=pipeline-beta`, taking one sandbox issue
  To do → Done and sending one to each `Blocked` reason; then `on` for the board (clear the label variable).
- **Soak playbook (operators and agents):**
  - **`progress.finished` (In progress → In Main)** needs a merged PR that `Refs` the issue, no open linked PRs, every **Definition of Done** item checked `[x]`, and no `busy` label. After merge, check DoD on the issue body, then `finish-work` (or let the delivery agent do both). **`finish-work` without a complete DoD** after a resume tends to set **`Blocked=stalled`** — that is expected, not an engine bug.
  - **`ready.queued`:** with default `limits.wip`, Ready issues wait for free slots. Likely explanation: **PIPE-V2-D-SOAK-003** — WIP counts engine-started **In progress** issues plus Ready issues with a delivery launch in flight (#2553 P3). A Ready issue with a pending or unacknowledged launch holds a slot until its ack window passes. For drain-only soak windows, set repo variable **`WIP_LIMIT=off`** (workflow passes it into the tick; see `applyWipOverride` in `issue_pipeline_v2_config.js`), then remove the variable when done.
  - **Live vs dry-run:** signed reviews and merges between ticks apply on the **next** `on` tick (**PIPE-V2-D-SOAK-007**).
  - **Teardown:** close sandbox issues only when no delivery PR is open and the row’s pass criteria are met or explicitly abandoned; closing early can orphan agent runs ([soak2 sign-off](./changes/pipeline-v2-soak2-findings.md) documents premature close of **#2498** / **#2501** with open PRs).
- **Soak2 (2026-11-21 – 2026-11-22):** sign-off
  [pipeline-v2-soak2-findings.md](./changes/pipeline-v2-soak2-findings.md) — **To do → Done not proven**; shipped **#2510**, **#2511**, **#2512**, **#2517**. Fixtures **#2493–#2508** closed 2026-11-22. **Soak3:** new fixtures and a new proposal under `changes/`; proposed gates are listed in the findings doc until accepted here.
- **Preflight:** in-scope sections (including **Acceptance criteria**) still participate in `detectRiskyScope` (**#2517** only excludes **`### Out of scope`**). Soak2 **#2506** showed operator body reword to launch — agents must not do that (**SOAK-008**); treat in-scope keyword trips as an **open finding** until soak3 or a scan change.
- **Board:** group the Pawpet board by `Stage`; make sure new issues and follow-ups are added to it (auto-add).
- **Project workflows:** turn off the built-in "Item closed" and "Pull request merged" workflows (they set Done and
  race the engine). "Auto-close issue" (Status Done closes the issue) agrees with the engine closing at Done and can stay on.

