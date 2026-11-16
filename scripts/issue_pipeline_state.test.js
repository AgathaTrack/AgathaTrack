'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findLatestStateComment } = require('./issue_pipeline_state');

test('findLatestStateComment prefers newest updated_at', () => {
  const latest = findLatestStateComment([
    {
      id: 1,
      created_at: '2026-11-15T10:00:00Z',
      updated_at: '2026-11-15T10:00:00Z',
      body: '<!-- agent-state: {"round":1,"body_sha":"old"} -->',
    },
    {
      id: 2,
      created_at: '2026-11-15T09:00:00Z',
      updated_at: '2026-11-15T12:00:00Z',
      body: '<!-- agent-state: {"round":2,"body_sha":"new"} -->',
    },
  ]);
  assert.equal(latest.state.round, 2);
  assert.equal(latest.commentId, 2);
});