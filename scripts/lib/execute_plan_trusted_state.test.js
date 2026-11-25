'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const trusted = require('./execute_plan_trusted_state');
const { resolvePipelineMode } = require('../issue_pipeline_v2_mode');

test('trusted-state module does not require the old issue_pipeline_state module', () => {
  const source = fs.readFileSync(path.join(__dirname, 'execute_plan_trusted_state.js'), 'utf8');
  assert.equal(/require\(['"][^'"]*issue_pipeline_state['"]\)/.test(source), false);
});

test('no trusted comment fails closed (null, so the approve path returns no-pipeline-state)', () => {
  assert.equal(trusted.findLatestTrustedStateComment([]), null);
  assert.equal(trusted.findLatestTrustedStateComment(null), null);
});

test('a trusted state comment is found; an untrusted author is ignored', () => {
  const body = `${trusted.PIPELINE_STATE_MARKER}\n${trusted.STATE_MARKER}{"round":2,"converged_at":"x"} -->`;
  const comments = [
    { id: 1, body, user: { login: 'someone-else' }, updated_at: '2026-11-20T00:00:00Z' },
    { id: 2, body, user: { login: 'pawpet-bot' }, updated_at: '2026-11-21T00:00:00Z' },
  ];
  const latest = trusted.findLatestTrustedStateComment(comments);
  assert.equal(latest.commentId, 2);
  assert.equal(latest.state.round, 2);
});

test('resolvePipelineMode moved to the v2 module keeps its contract', () => {
  assert.equal(resolvePipelineMode('ON'), 'on');
  assert.equal(resolvePipelineMode(' dry-run '), 'dry-run');
  assert.equal(resolvePipelineMode('anything'), 'off');
  assert.equal(resolvePipelineMode(undefined), 'off');
});
