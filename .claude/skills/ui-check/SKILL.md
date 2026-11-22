---
name: ui-check
description: >-
  INTERNAL (Tier 3) — superseded by Engineering Router + .cursor/agent-kernel/protocols/accessibility.md
  §Quick pass. Do not user-invoke; Tier 1 skills load accessibility protocol automatically.
disable-model-invocation: true
---

# UI check (Claude Code wrapper — internal)

The Cursor source, `.cursor/skills/ui-check/SKILL.md`, is marked internal and superseded. It says not to invoke it manually, so this page does not send you back to it. It applies the current check and nothing else.

## Quick pass

Read `.cursor/agent-kernel/protocols/accessibility.md` §Quick pass and check:

1. Purpose clear in 5 seconds?
2. Primary action obvious?
3. Labels on inputs; focus visible; touch target at least 48dp
4. Theme `colorScheme` used, no ad-hoc colours
5. Empty, loading and error states still reasonable?
6. Auth or landing: role-neutral entry, if touched

Escalate to `/ui-design-deep` for theme, landing/auth, multi-screen, or work spanning `/g/*` and `/o/*`.

## Verify

```bash
./scripts/pre-push-changed.sh
```

The source's `paths:` scoping is Cursor-only and is not carried over.
