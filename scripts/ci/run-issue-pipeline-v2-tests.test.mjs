import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REPO_ROOT,
  discoverIssuePipelineV2Tests,
  parseTapTotals,
} from './run-issue-pipeline-v2-tests.mjs';

function tempScriptsDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-discovery-'));
  for (const name of names) fs.writeFileSync(path.join(dir, name), '');
  return dir;
}

test('discovery matches issue_pipeline_v2*.test.js by convention only', () => {
  const dir = tempScriptsDir([
    'issue_pipeline_v2.test.js',
    'issue_pipeline_v2_brand_new.test.js',
    'issue_pipeline_v2.js',
    'issue_pipeline_v2_helper.js',
    'issue_pipeline_legacy.test.js',
    'other_issue_pipeline_v2.test.js',
  ]);
  try {
    const names = discoverIssuePipelineV2Tests(dir).map((f) => path.basename(f));
    assert.deepEqual(names, ['issue_pipeline_v2.test.js', 'issue_pipeline_v2_brand_new.test.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery on the repo finds every v2 test file on disk', () => {
  const onDisk = fs
    .readdirSync(path.join(REPO_ROOT, 'scripts'))
    .filter((n) => /^issue_pipeline_v2.*\.test\.js$/.test(n))
    .sort();
  const found = discoverIssuePipelineV2Tests().map((f) => path.basename(f));
  assert.ok(onDisk.length > 0, 'expected at least one v2 test file');
  assert.deepEqual(found, onDisk);
});

test('parseTapTotals reads node --test summary lines', () => {
  const tap = [
    'ok 1 - a',
    '1..18',
    '# tests 248',
    '# suites 0',
    '# pass 246',
    '# fail 1',
    '# cancelled 0',
    '# skipped 1',
    '# todo 0',
  ].join('\n');
  assert.deepEqual(parseTapTotals(tap), {
    tests: 248,
    pass: 246,
    fail: 1,
    cancelled: 0,
    skipped: 1,
    todo: 0,
  });
});

test('parseTapTotals returns null for missing totals so a parse failure is not a pass', () => {
  const totals = parseTapTotals('ok 1 - only a subtest');
  assert.equal(totals.tests, null);
  assert.equal(totals.fail, null);
});

test('CI and pre-push run the convention runner and no hand-written v2 test list', () => {
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/_reusable-test.yml'), 'utf8');
  const prepush = fs.readFileSync(path.join(REPO_ROOT, 'scripts/pre-push-changed.sh'), 'utf8');
  assert.match(ci, /node scripts\/ci\/run-issue-pipeline-v2-tests\.mjs/);
  assert.match(prepush, /run_prepush_gate issue-pipeline-v2-tests/);
  for (const [label, text] of [['_reusable-test.yml', ci], ['pre-push-changed.sh', prepush]]) {
    assert.doesNotMatch(
      text,
      /node --test [^\n]*scripts\/issue_pipeline_v2/,
      `${label} must not hand-list v2 test files`,
    );
  }
});
