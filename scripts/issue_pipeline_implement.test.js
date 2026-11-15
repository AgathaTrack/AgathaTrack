'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canQueueImplement, deliveryHandoffLines } = require('./issue_pipeline_implement');
const { countWipInUse } = require('./issue_pipeline_dispatcher');

test('canQueueImplement requires converged body_sha', () => {
  const blocked = canQueueImplement({
    status: 'Ready',
    labels: ['PR'],
    assignees: [],
    state: { body_sha: 'aaa', converged_at: '2026-11-15T00:00:00Z' },
    liveBodySha: 'bbb',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'body_sha-mismatch');

  const ok = canQueueImplement({
    status: 'Ready',
    labels: ['PR'],
    assignees: [],
    state: { body_sha: 'abc', converged_at: '2026-11-15T00:00:00Z' },
    liveBodySha: 'abc',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.method, 'PR');
});

test('implement queue rejected without converged_at', () => {
  const gate = canQueueImplement({
    labels: ['PR'],
    status: 'Ready',
    assignees: [],
    liveBodySha: 'abc',
    state: { body_sha: 'abc' },
  });
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'not-converged');
});

test('deliveryHandoffLines references light-plan skill', () => {
  const lines = deliveryHandoffLines('light-plan', 99).join('\n');
  assert.match(lines, /light-plan/);
  assert.match(lines, /#99/);
});

test('countWipInUse counts in-progress pawpet-bot without requiring busy', () => {
  const n = countWipInUse([
    { status: 'In progress', assignees: ['pawpet-bot'], labels: ['busy'] },
    { status: 'In progress', assignees: ['pawpet-bot'], labels: [] },
    { status: 'Ready', assignees: [], labels: ['busy'] },
  ]);
  assert.equal(n, 2);
});