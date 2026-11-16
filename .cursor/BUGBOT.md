# Bugbot review rules (AgathaTrack)

Bugbot runs when GitHub Copilot PR review is absent (see `cursor-review-fallback.yml`). Triage its threads like Copilot.

## Scope

- Review only the PR diff; no drive-by refactors or new features.
- Respect atomic-PR policy: one verifiable outcome per PR.
- Do not ask for changes that belong in separate debt issues unless they are security or merge blockers.

## Priorities (high → low)

1. Security, auth, data integrity, migration safety
2. Correctness bugs and broken API contracts
3. Missing tests for changed behavior when the area already has tests
4. Style nits only when they mask a real defect

## Ignore

- Suggestions to expand scope ("and also…")
- Rewrites of unchanged files
- Product decisions not answered in the canonical feature doc

## Sensitive paths

- `.github/**`, `.cursor/agent-kernel/**`: flag risk but assume owner review via CODEOWNERS.