# Scripts index

Supported entry points for documentation validation, PR babysitting, and local pre-push checks. Runbooks live in [`scripts/BABYSIT_README.md`](./BABYSIT_README.md) unless noted.

## Documentation validation

| Task | Script | What it changes | Offline test | Runbook |
|------|--------|-----------------|--------------|---------|
| Docs integrity gate | `./scripts/validate_docs.sh` | Read-only; reports broken links, placement, canonical gates | `node --test scripts/validate_docs.fixture.test.mjs` | [BABYSIT_README](./BABYSIT_README.md#validation-script-validate_docssh) |
| Strict docs (CI) | `./scripts/validate_docs.sh --strict` | Same as above; duplicate patterns can fail in strict mode | `bash scripts/validate_docs.sh --strict` | [Governance gates](/docs/agent-efficiency/governance-gates.md) |
| Link checker module | `node scripts/lib/validate_markdown_links.mjs` | Read-only link pass | Covered by `validate_docs.fixture.test.mjs` | [BABYSIT_README §links](./BABYSIT_README.md) |

## PR babysit helpers

| Task | Script | What it changes | Offline test | Runbook |
|------|--------|-----------------|--------------|---------|
| Docs PR auto-fix | `./scripts/auto_fix_docs.sh --pr <n> [--dry-run]` | May commit doc fixes on the PR branch | `node --test scripts/validate_docs.fixture.test.mjs` (invocation contract) | [BABYSIT_README](./BABYSIT_README.md#auto-fix-script-auto_fix_docssh) |
| Universal babysit | `./scripts/universal_babysit.sh --pr <n> [--merge] [--dry-run]` | Syncs base, triages reviews, may commit/push fixes; stops on push failure | `node --test scripts/validate_docs.fixture.test.mjs` (invocation + push guard) | [BABYSIT_README](./BABYSIT_README.md#universal-babysit-universal_babysitsh) |
| Review gate (used by helpers) | `node scripts/babysit_pr_reviews.js gate --pr <url>` | Read-only thread collection | `node --test scripts/babysit_pr_reviews.test.js` | [`babysit-plus` skill](/.cursor/skills/babysit-plus/SKILL.md) |
| Base sync (used by helpers) | `./scripts/babysit_sync_base.sh --pr <n> --push` | May rebase and push the PR branch | `node --test scripts/ccr_gh_shim.test.js` | [BABYSIT_README](./BABYSIT_README.md) |

## Pre-push

| Task | Script | What it changes | Offline test | Runbook |
|------|--------|-----------------|--------------|---------|
| Changed-files verify | `./scripts/pre-push-changed.sh` | Read-only local gates subset | Run before any push | [AGENTS.md](/AGENTS.md) |
| Full verify (release) | `./scripts/pre-push.sh` | Read-only full local gate suite | Before integration → `main` release PR | [CONTRIBUTING.md](/CONTRIBUTING.md) |

## Related canonical docs

- [Autonomous PR policy](/docs/agent-efficiency/autonomous-pr-policy.md)
- [CI/CD gates](/docs/pipelines/ci-cd-gates.md)
- [Documentation standards](/docs/domains/documentation/standards.md)