'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REEXEC_GUARD = /if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{[\s\S]*?reexecWithEnvProxy\s*\(\s*\)/;

/**
 * Node CLIs agents may run in Claude Code / Cursor Cloud sandboxes that reach GitHub through
 * `fetch` (directly or via `github-project-lib` / `execute_plan_github`). See
 * docs/engineering/cursor-cloud-environment.md.
 */
const AGENT_INVOKED_FETCH_CLIS = [
  'scripts/github_issue_workflow.js',
  'scripts/execute_plan_runtime.js',
  'scripts/pipeline_verdict.js',
];

/**
 * @param {string} fileContent
 * @returns {{ ok: boolean, reason?: string }}
 */
function assertReexecGuardBeforeGitHubRequires(fileContent) {
  const firstGithubRequire = fileContent.search(
    /require\s*\(\s*['"][^'"]*(?:github-project-lib|execute_plan_github)/,
  );
  const guardAt = fileContent.search(REEXEC_GUARD);
  if (guardAt === -1) {
    return { ok: false, reason: 'missing-reexec-guard' };
  }
  if (firstGithubRequire !== -1 && guardAt > firstGithubRequire) {
    return { ok: false, reason: 'reexec-after-github-require' };
  }
  return { ok: true };
}

/**
 * @param {string} repoRoot
 * @param {string} relPath
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkAgentInvokedCliFile(repoRoot, relPath) {
  const abs = path.join(repoRoot, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  return assertReexecGuardBeforeGitHubRequires(content);
}

module.exports = {
  AGENT_INVOKED_FETCH_CLIS,
  REEXEC_GUARD,
  assertReexecGuardBeforeGitHubRequires,
  checkAgentInvokedCliFile,
};