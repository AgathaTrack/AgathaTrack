---
name: ui-design-deep
description: In-depth UX, accessibility, and design-system review for new flows, landing/auth refresh, theme changes, or multi-screen consistency. Router design-scoped profile; use accessibility protocol quick pass for routine polish.
disable-model-invocation: true
---

# UI design deep (Claude Code wrapper)

Read and follow `.cursor/skills/ui-design-deep/SKILL.md`. That file is the procedure of record, including the design-system reading list and the 9-part output. This page lists only what changes in Claude Code. Do not copy the procedure here.

## Claude Code adaptations

| In the Cursor source | In Claude Code |
|----------------------|----------------|
| `.cursor/agent-kernel/ROUTER.md`, `.cursor/rules/*.mdc`, `docs/design/*` | Plain files here. Read them with Read. |
| Visual review of screens (no tool named; Cursor sessions use `computerUse`) | Not available. Use Playwright on the preinstalled Chromium against the local server (`http://localhost:3000/`). Take screenshots at `deviceScaleFactor: 2` when a person will look at them. Do not run `playwright install`. |
| Subagents for parallel audits | Only if you ask for them. |
| Verify: `node scripts/check_file_size.js`, `flutter analyze`, `./scripts/pre-push-changed.sh` | Unchanged. Run them with Bash. |

For routine widget polish, use the accessibility protocol's quick pass instead of this skill.
