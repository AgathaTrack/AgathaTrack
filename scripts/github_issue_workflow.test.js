#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFlags, readBody } = require('./lib/github_issue_workflow_lib');
const { aatLabelPlan } = require('./lib/github_issue_workflow_aat');

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
