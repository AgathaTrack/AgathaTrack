---
name: add-bdd-playwright-scenario
description: Map a Gherkin scenario to a Playwright E2E test with @bdd header, page objects, and BDD coverage gate. Use when implementing BDD coverage, adding E2E for a feature file, or Sprint 6+ org/guardian journeys.
---

# Add BDD → Playwright scenario (Claude Code wrapper)

Read and follow `.cursor/skills/add-bdd-playwright-scenario/SKILL.md`. That file is the procedure of record, including the @bdd header rules and the verify gate. This page lists only what changes in Claude Code. Do not copy the procedure here.

## Claude Code adaptations

| In the Cursor source | In Claude Code |
|----------------------|----------------|
| §Steps 10: run `/ui-check` on affected screens | Apply the accessibility quick pass, `.cursor/agent-kernel/protocols/accessibility.md` §Quick pass. `/ui-check` is superseded. |
| Local Playwright runs (`./e2e/scripts/run-local.sh`) | The script runs `npx playwright install chromium --with-deps` itself. Let it run as written; this PR does not change it. If the install fails here, use the preinstalled `/opt/pw-browsers/chromium`. Add `--trace off` unless a trace is needed. |
| Frontmatter `paths:` (`e2e/**`, `flutter_app/test/bdd/**`) | Cursor-only. The description is what triggers this skill here. |
| §Parallel sprint rules: `/spawn-sprint-agents` | Not used. One agent in this session, unless you ask for subagents. |

Gherkin title matching, the `@bdd` header rules, the priority tags and the coverage gate are unchanged.
