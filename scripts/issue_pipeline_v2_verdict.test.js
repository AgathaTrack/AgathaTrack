'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findVerifiedVerdicts } = require('./issue_pipeline_v2_verdict');
const { deriveRunSecret, verdictSignature } = require('./issue_pipeline_v2_secrets');
const { buildLaunchRecord } = require('./issue_pipeline_v2_launch');
const { buildReviewRequest, deriveReviewFacts } = require('./issue_pipeline_v2_review');
const { loadConfig } = require('./issue_pipeline_v2_config');

const config = loadConfig();
const KEY = 'k'.repeat(32);
const NONCE = 'ab'.repeat(16);
const HASH = 'h'.repeat(16);
const T0 = Date.parse('2026-11-18T10:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const ENGINE = ['pawpet-engine'];

function launch(stage = 'In analysis') {
  return {
    id: 1,
    user: { login: 'pawpet-engine' },
    created_at: iso(0),
    body: buildLaunchRecord({ runId: 'r', agent: 'cursor-b', purpose: 'doorbell', stage, nonce: NONCE }),
  };
}

function verdict({ id = 2, author = 'pawpet-bot', at = 10, kind = 'review', value = 'up', stage = 'In analysis' }) {
  const secret = deriveRunSecret(KEY, 5, 'cursor-b', stage, NONCE);
  const sig = verdictSignature(secret, 5, 'cursor-b', NONCE, kind, HASH, value);
  return {
    id,
    user: { login: author },
    created_at: iso(at),
    body: `<!-- v2:verdict agent=cursor-b nonce=${NONCE} kind=${kind} hash=${HASH} value=${value} sig=${sig} -->`,
  };
}

const find = (comments, extra = {}) =>
  findVerifiedVerdicts({
    comments: [launch(extra.stage), ...comments],
    config,
    engineLogins: ENGINE,
    issueNumber: 5,
    bodyHash: HASH,
    voteKey: KEY,
    limits: config.limits,
    ...extra.opts,
  });

test('verdict posted before the timeout counts however late a tick reads it', () => {
  assert.equal(find([verdict({ at: 25 })]).length, 1);
});

test('verdict posted after the launch timeout is ignored', () => {
  assert.equal(find([verdict({ at: 45 })]).length, 0);
});

test('verdict whose author is not the id actsAs is ignored', () => {
  assert.equal(find([verdict({ author: 'someone-else' })]).length, 0);
});

test('kind must fit the launch stage', () => {
  assert.equal(find([verdict({ kind: 'spec' })]).length, 0);
  assert.equal(find([verdict({ kind: 'spec', stage: 'To do' })], { stage: 'To do' }).length, 1);
});

test('only the first verdict of a kind on a hash counts', () => {
  assert.equal(find([verdict({ id: 2, at: 10 }), verdict({ id: 3, at: 11 })]).length, 1);
});

function reviewFacts(edits, claimAt) {
  const request = {
    id: 9,
    user: { login: 'pawpet-engine' },
    created_at: iso(-5),
    updated_at: iso(-5),
    body: buildReviewRequest({ hash: HASH, assigned: 'cursor-b', config }),
  };
  return deriveReviewFacts({
    comments: [request, launch(), verdict({ kind: 'edit', at: claimAt })],
    reactionsByComment: {},
    edits,
    bodyAuthor: 'human',
    config,
    engineLogins: ENGINE,
    editors: {},
    issueNumber: 5,
    bodyHash: HASH,
    voteKey: KEY,
    limits: config.limits,
    now: T0 + 60 * 60000,
  });
}

test('edit claim counts only when it follows the newest edit by the id login', () => {
  assert.equal(reviewFacts([{ editor: 'pawpet-bot', editedAt: iso(5) }], 10).editorAgentId, 'cursor-b');
});

test('edit claim older than a later same-login revert does not count (A/B revert)', () => {
  const edits = [
    { editor: 'pawpet-bot', editedAt: iso(5) },
    { editor: 'pawpet-bot', editedAt: iso(12) },
  ];
  assert.equal(reviewFacts(edits, 10).editorAgentId, null);
});

test('edit claim does not count when the newest editor is a human', () => {
  assert.equal(reviewFacts([{ editor: 'KanopeeKa', editedAt: iso(5) }], 10).editorAgentId, null);
});
