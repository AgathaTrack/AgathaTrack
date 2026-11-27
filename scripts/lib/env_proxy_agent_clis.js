'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REEXEC_GUARD = /if\s*\(\s*require\.main\s*===\s*module\s*\)\s*\{[\s\S]*?reexecWithEnvProxy\s*\(\s*\)/;
const GITHUB_REQUIRE = /require\s*\([^)]*(?:github-project-lib|execute_plan_github)/;

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

function resolveRequire(fromDir, spec) {
  if (!spec.startsWith('.')) {
    return null;
  }
  const base = path.resolve(fromDir, spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function moduleReachesGithub(absPath, seen = new Set()) {
  if (seen.has(absPath)) {
    return false;
  }
  seen.add(absPath);
  const content = fs.readFileSync(absPath, 'utf8');
  if (GITHUB_REQUIRE.test(content)) {
    return true;
  }
  const dir = path.dirname(absPath);
  for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const next = resolveRequire(dir, m[1]);
    if (next && moduleReachesGithub(next, seen)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} fileContent
 * @param {{ cliAbsPath?: string }} [opts]
 * @returns {{ ok: boolean, reason?: string }}
 */
function assertReexecGuardBeforeGitHubRequires(fileContent, opts = {}) {
  const guardMatch = fileContent.match(REEXEC_GUARD);
  if (!guardMatch) {
    return { ok: false, reason: 'missing-reexec-guard' };
  }
  const guardLine = fileContent.slice(0, guardMatch.index).split('\n').length - 1;
  const lines = fileContent.split('\n');
  let depth = 0;
  const cliDir = opts.cliAbsPath ? path.dirname(opts.cliAbsPath) : null;

  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth += 1;
      }
      if (ch === '}') {
        depth -= 1;
      }
    }
    if (depth !== 0) {
      continue;
    }
    const req = lines[i].match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (!req) {
      continue;
    }
    let reachesGithub = GITHUB_REQUIRE.test(lines[i]);
    if (!reachesGithub && cliDir) {
      const resolved = resolveRequire(cliDir, req[1]);
      if (resolved) {
        reachesGithub = moduleReachesGithub(resolved);
      }
    }
    if (reachesGithub && guardLine >= i) {
      return { ok: false, reason: `reexec-after-github-require at line ${i + 1}` };
    }
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
  return assertReexecGuardBeforeGitHubRequires(content, { cliAbsPath: abs });
}

module.exports = {
  AGENT_INVOKED_FETCH_CLIS,
  REEXEC_GUARD,
  assertReexecGuardBeforeGitHubRequires,
  checkAgentInvokedCliFile,
  moduleReachesGithub,
  resolveRequire,
};