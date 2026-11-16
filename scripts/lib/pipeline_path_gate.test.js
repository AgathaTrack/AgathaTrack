'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluatePlannedPathGlobs } = require('./pipeline_path_gate');

const TRACKED = [
  'flutter_app/lib/main.dart',
  'docs/agent-efficiency/foo.md',
  'server/app.js',
];

test('evaluatePlannedPathGlobs rejects glob spanning .github', () => {
  const check = evaluatePlannedPathGlobs(['**/*'], TRACKED);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'sensitive-paths');
  assert.ok(check.protectedHits.some((p) => p.includes('.github')));
});

test('evaluatePlannedPathGlobs rejects new workflow path with no tracked file', () => {
  const check = evaluatePlannedPathGlobs(['.github/workflows/new.yml'], TRACKED);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'sensitive-paths');
});

test('evaluatePlannedPathGlobs passes safe scoped globs', () => {
  const check = evaluatePlannedPathGlobs(['flutter_app/**'], TRACKED);
  assert.equal(check.ok, true);
});

test('evaluatePlannedPathGlobs rejects unmatched glob with no allowed sample', () => {
  const check = evaluatePlannedPathGlobs(['novelty/path/**'], TRACKED);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'unmatched-globs');
});