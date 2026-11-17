#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFlags, readBody } = require('./lib/github_issue_workflow_lib');
const {
  aatLabelPlan,
  buildAatMarker,
  appendAatMarker,
  validateMergeSha,
  lastMainMergeShaFromLinkedPrs,
} = require('./lib/github_issue_workflow_aat');
const { resolveAatMergeSha } = require('./lib/github_issue_workflow_aat_merge');

const SAMPLE_SHA = 'a'.repeat(40);

test('parseFlags reads boolean and value flags', () => {
  assert.deepEqual(parseFlags(['--issue', '12', '--body', 'hi', '--write']), {
    issue: '12',
    body: 'hi',
    write: true,
  });
});

test('readBody prefers --body over --body-file', () => {
  const body = readBody({ body: 'inline', 'body-file': '/tmp/ignored' });
  assert.equal(body, 'inline');
});

test('aatLabelPlan clears opposing labels on pass and fail', () => {
  assert.deepEqual(aatLabelPlan('start'), {
    add: ['AAT-progress'],
    remove: ['AAT-passed', 'AAT-failed'],
  });
  assert.deepEqual(aatLabelPlan('pass'), {
    add: ['AAT-passed'],
    remove: ['AAT-progress', 'AAT-failed'],
  });
  assert.deepEqual(aatLabelPlan('fail'), {
    add: ['AAT-failed'],
    remove: ['AAT-progress', 'AAT-passed'],
  });
  assert.deepEqual(aatLabelPlan('inconclusive'), {
    add: [],
    remove: ['AAT-progress', 'AAT-passed', 'AAT-failed'],
  });
});

test('buildAatMarker and appendAatMarker', () => {
  const marker = buildAatMarker('pass', SAMPLE_SHA);
  assert.match(marker, /^<!-- v2:aat verdict=pass merge=a{40} -->$/);
  const body = appendAatMarker('Review body', 'fail', SAMPLE_SHA);
  assert.match(body, /Review body\n\n<!-- v2:aat verdict=fail merge=a{40} -->\n$/);
});

test('validateMergeSha rejects bad input', () => {
  assert.throws(() => validateMergeSha(''), /missing merge SHA/);
  assert.throws(() => validateMergeSha('abc'), /invalid or missing merge SHA/);
  assert.equal(validateMergeSha(SAMPLE_SHA.toUpperCase()), SAMPLE_SHA);
});

test('lastMainMergeShaFromLinkedPrs picks latest main merge', () => {
  const sha1 = 'b'.repeat(40);
  const sha2 = 'c'.repeat(40);
  const prs = [
    { merged: true, base: 'main', mergedAt: '2026-01-01T00:00:00Z', mergeSha: sha1 },
    { merged: true, base: 'main', mergedAt: '2026-02-01T00:00:00Z', mergeSha: sha2 },
    { merged: true, base: 'cursor/integration', mergedAt: '2026-03-01T00:00:00Z', mergeSha: 'd'.repeat(40) },
  ];
  assert.equal(lastMainMergeShaFromLinkedPrs(prs), sha2);
});

test('resolveAatMergeSha uses explicit --merge without API', async () => {
  const sha = await resolveAatMergeSha({
    issueNumber: 1,
    owner: 'o',
    repo: 'r',
    merge: SAMPLE_SHA,
    token: null,
    listLinkedPrs: async () => {
      throw new Error('should not call API');
    },
  });
  assert.equal(sha, SAMPLE_SHA);
});

test('resolveAatMergeSha requires token when merge omitted', async () => {
  await assert.rejects(
    () =>
      resolveAatMergeSha({
        issueNumber: 1,
        owner: 'o',
        repo: 'r',
        token: null,
      }),
    /merge SHA required/,
  );
});

test('readBody reads --body-file', () => {
  const file = path.join(os.tmpdir(), `issue-body-${process.pid}.txt`);
  fs.writeFileSync(file, 'from file\n');
  try {
    assert.equal(readBody({ 'body-file': file }), 'from file\n');
  } finally {
    fs.unlinkSync(file);
  }
});