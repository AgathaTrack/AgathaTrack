---
name: pre-push-verify
description: Run the correct pre-push verification before git push — changed-files subset during iteration, full suite before merge to main. Use when ready to push, before creating PR, or when CI failed locally.
---

# Pre-push verify (Claude Code wrapper)

Read and follow `.cursor/skills/pre-push-verify/SKILL.md`. That file is the procedure of record, including the script-choice table. This page lists only what changes in Claude Code. Do not copy the procedure here.

## Claude Code adaptations

| In the Cursor source | In Claude Code |
|----------------------|----------------|
| Full `./scripts/pre-push.sh` (before integration → main or a single-agent merge) | It can run longer than a foreground Bash call allows. Start it with `run_in_background` and wait for the completion notice. Do not poll with `sleep`. |
| §UI-touching changes: `/ui-design-deep` | Use the `ui-design-deep` wrapper for theme, landing/auth or multi-screen work. |
| §Tool tip: use the `read` tool for exact strings | Use Read (or Grep) for exact strings. |
| Parity line `parity: n/n cheap CI gates run` | Paste it into the PR's Test plan section. |
| §E2E remedial shard replay (`--e2e-shards`) | Needs the stack running. See the `e2e-debug` wrapper. |

The script choice, the changed-paths table and the "CI is authoritative" rule are unchanged.
