'use strict';

/**
 * resolve-trigger in deploy-prod.yml sparse-checkouts only the scripts the AAT prod gate needs.
 * Missing paths fail at runtime on the runner with MODULE_NOT_FOUND (see run 46096999157).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'deploy-prod.yml');
const ENTRY = 'scripts/ci/aat-prod-gate.js';
const REQUIRE_RE = /require\(['"]([^'"]+)['"]\)/g;

function parseSparseCheckout(yaml) {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.trim() === 'sparse-checkout: |');
  assert.ok(start >= 0, 'sparse-checkout block not found in deploy-prod.yml');
  const paths = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('            ')) break;
    const p = line.trim();
    if (p) paths.push(p);
  }
  assert.ok(paths.length > 0, 'sparse-checkout path list is empty');
  return new Set(paths);
}

function resolveReq(fromFile, req) {
  if (!req.startsWith('.')) return null;
  const base = path.dirname(fromFile);
  const normalized = path.normalize(path.join(base, req));
  for (const ext of ['', '.js', '.json', '/index.js']) {
    const cand = normalized + ext;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return path.relative(ROOT, cand).split(path.sep).join('/');
    }
  }
  return path.relative(ROOT, normalized).split(path.sep).join('/');
}

function missingRepoRequires(sparse, entryRel) {
  const missing = new Set();
  const visited = new Set();
  const queue = [entryRel];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      missing.add(`${rel} (not on disk)`);
      continue;
    }
    if ((rel.startsWith('scripts/') || rel.startsWith('.github/')) && !sparse.has(rel)) {
      missing.add(rel);
    }
    const src = fs.readFileSync(abs, 'utf8');
    REQUIRE_RE.lastIndex = 0;
    let m;
    while ((m = REQUIRE_RE.exec(src))) {
      const dep = resolveReq(rel, m[1]);
      if (dep && (dep.startsWith('scripts/') || dep.startsWith('.github/')) && !visited.has(dep)) {
        queue.push(dep);
      }
    }
  }
  return [...missing].sort();
}

test('deploy-prod sparse-checkout includes all repo requires for aat-prod-gate', () => {
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');
  const sparse = parseSparseCheckout(yaml);
  const missing = missingRepoRequires(sparse, ENTRY);
  assert.deepEqual(missing, [], `add to deploy-prod.yml sparse-checkout:\n${missing.join('\n')}`);
});