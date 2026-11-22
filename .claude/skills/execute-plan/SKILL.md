---
name: execute-plan
description: Run a multi-phase autonomous v2 plan from a frozen snapshot in Claude Code (`/execute-plan [plan_id]`). Worker sessions use tick; end when actor is driver or stop.
---

# Execute-plan (Claude Code wrapper)

Read and follow `.cursor/skills/execute-plan/SKILL.md` (v2 loop). Contract: `AGENTS.md` §Execute-plan.

**Worker:** `env -u OWNER_GH_TOKEN -u BOT_GH_TOKEN node scripts/execute_plan_runtime.js tick <plan_id> --json --actor agent` → one `agent` action → `tick` again.

Each command may run in a fresh shell, so prefix every `tick` with `env -u`; `unset` does not carry over.

**Cloud sessions:** GitHub GraphQL is blocked here. The runtime client detects `CLAUDE_CODE_REMOTE=true` and reads
review threads and sets auto-merge through the CCR routes, so `tick` runs unchanged. A thread-read error is never "no
threads" ([`execute-plan-v2.md`](../../../docs/agent-efficiency/plans/execute-plan-v2.md) decision log 2026-11-22).

**Planning:** `init <plan_id>` on branch `cursor/<plan_id>-init`; end with the printed approval line.

**CI wait:** `watch-ci` / subscribe — never `sleep`.

**Plan PRs:** do not babysit or merge; owner controls (`execute-plan-hold`, `do-not-merge`,
approve / `resume-autonomous` / `revoke-autonomous`, `EXECUTE_PLAN_DRIVER=off`) — see cursor skill §Owner controls.

Spec: [`execute-plan-v2.md`](../../../docs/agent-efficiency/plans/execute-plan-v2.md).
