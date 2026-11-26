'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('./issue_pipeline_wake');

test('parseArgs: defaults mission analyse and live false', () => {
  const args = parseArgs(['node', 'issue_pipeline_wake.js', '--issue', '99']);
  assert.deepEqual(args, { issue: '99', mission: 'analyse', live: false, help: false, error: null });
});

test('parseArgs: mission and live flags', () => {
  const args = parseArgs(['node', 'wake', '--issue', '12', '--mission', 'board', '--live']);
  assert.deepEqual(args, { issue: '12', mission: 'board', live: true, help: false, error: null });
});