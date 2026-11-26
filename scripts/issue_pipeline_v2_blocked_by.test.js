'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('./issue_pipeline_v2_decide');
const { loadConfig } = require('./issue_pipeline_v2_config');

const config = loadConfig();

function facts(over = {}) {
  return {
    mode: 'dry-run',
    now: Date.now(),
    onBoard: true,
    labels: [],
    stage: 'Ready',
    blocked: '',
    bodyHash: 'h1',
    wip: 0,
    deliveryMethod: 'PR',
    ...over,
  };
}

test('blocked-by: open blockers skip launch and stage writes', () => {
  const action = decide(facts({ blockedByOpen: [100, 101] }), config);
  assert.equal(action.type, 'none');
  assert.equal(action.row, 'blocked-by');
  assert.deepEqual(action.blockers, [100, 101]);
});

test('blocked-by: no blockers allows the Ready row to run', () => {
  const action = decide(facts({ blockedByOpen: [], wip: 0 }), config);
  assert.notEqual(action.row, 'blocked-by');
});

test('blocked-by: all blockers closed (empty list) is not held', () => {
  const row = decide(facts({ blockedByOpen: [] }), config).row;
  assert.notEqual(row, 'blocked-by');
  assert.notEqual(row, 'blocked-by.read-failed');
});

test('blocked-by: relationship read failure fails closed for the issue', () => {
  const action = decide(facts({ blockedByReadError: 'graphql 403' }), config);
  assert.equal(action.row, 'blocked-by.read-failed');
});

test('blocked-by: engine Blocked field is separate from GitHub blockers', () => {
  const action = decide(facts({ blocked: 'question', blockedByOpen: [50] }), config);
  assert.equal(action.row, 'blocked-by');
});