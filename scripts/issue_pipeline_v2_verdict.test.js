'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findVerifiedVerdicts, findConfirmedClaims } = require('./issue_pipeline_v2_verdict');
const { commitOf } = require('./issue_pipeline_v2_secrets');
const { buildLaunchRecord } = require('./issue_pipeline_v2_launch');
const { buildReviewRequest, deriveReviewFacts } = require('./issue_pipeline_v2_review');
const { loadConfig } = require('./issue_pipeline_v2_config');

const config = loadConfig();
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
  return {
    id,
    user: { login: author },
    created_at: iso(at),
    body: `<!-- v2:verdict agent=cursor-b nonce=${NONCE} kind=${kind} hash=${HASH} value=${value} -->`,
  };
}

const find = (comments, extra = {}) =>
  findVerifiedVerdicts({
    comments: [launch(extra.stage), ...comments],
    config,
    engineLogins: ENGINE,
    issueNumber: 5,
    bodyHash: HASH,
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

test('no kind counts under a launch stage outside To do / In analysis', () => {
  assert.equal(find([verdict({ stage: 'In Main' })], { stage: 'In Main' }).length, 0);
});

test('a nonce is revealed once: a second verdict with the same nonce never counts, whatever it says', () => {
  const out = find([verdict({ id: 2, at: 10, value: 'down' }), verdict({ id: 3, at: 11, value: 'up' })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 'down', 'the first reveal wins');
});

const claim = ({ id = 7, author = 'pawpet-bot', at = 8, commit = commitOf(NONCE), hash = HASH } = {}) => ({
  id,
  user: { login: author },
  created_at: iso(at),
  body: `<!-- v2:claim agent=cursor-b kind=edit hash=${hash} commit=${commit} -->`,
});
const claims = (comments) =>
  findConfirmedClaims({ comments: [launch(), ...comments], config, engineLogins: ENGINE, limits: config.limits });

test('the launch record publishes the commit, never the nonce (PIPE-V2-D-REV3-011)', () => {
  assert.match(launch().body, new RegExp(`commit=${commitOf(NONCE)}`));
  assert.equal(launch().body.includes(NONCE), false);
});

test('a claim is not confirmed until its run reveals the nonce', () => {
  assert.equal(claims([claim()]).length, 0, 'no verdict yet: the claim is only a promise');
  assert.equal(claims([claim(), verdict({ at: 10 })]).length, 1, 'the reveal confirms it');
});

test('a claim naming a commit nobody revealed, or from another login, is never confirmed', () => {
  assert.equal(claims([claim({ commit: 'f'.repeat(64) }), verdict({ at: 10 })]).length, 0);
  assert.equal(claims([claim({ author: 'pawpet-claude' }), verdict({ at: 10 })]).length, 0);
});

test('a launch recorded before REV3-011 with a plain nonce still verifies', () => {
  const legacy = {
    id: 1,
    user: { login: 'pawpet-engine' },
    created_at: iso(0),
    body: `<!-- v2:launch run=r agent=cursor-b purpose=doorbell stage=In analysis nonce=${NONCE} -->`,
  };
  const out = findVerifiedVerdicts({ comments: [legacy, verdict({ at: 10 })], config, engineLogins: ENGINE, bodyHash: HASH, limits: config.limits });
  assert.equal(out.length, 1);
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
    comments: [request, launch(), claim({ at: claimAt }), verdict({ at: claimAt + 1 })],
    reactionsByComment: {},
    edits,
    bodyAuthor: 'human',
    config,
    engineLogins: ENGINE,
    editors: {},
    issueNumber: 5,
    bodyHash: HASH,
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

test('a verdict needs no key: the nonce of a launched run is its identity (PIPE-V2-D-REV3-010)', () => {
  const out = find([verdict({ at: 10 })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].agentId, 'cursor-b');
});

test('a legacy verdict with a sig= attribute is accepted, and the signature is ignored', () => {
  const legacy = {
    id: 3,
    user: { login: 'pawpet-bot' },
    created_at: iso(12),
    body: `<!-- v2:verdict agent=cursor-b nonce=${NONCE} kind=review hash=${HASH} value=up sig=${'0'.repeat(64)} -->`,
  };
  assert.equal(find([legacy]).length, 1, 'a wrong sig is not checked, so it does not reject the vote');
});
