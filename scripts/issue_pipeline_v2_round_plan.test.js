'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { buildReviewRequest } = require('./issue_pipeline_v2_review');
const { planRounds } = require('./issue_pipeline_v2_round_plan');

const config = loadConfig();
const ENGINE = config.engine.logins;
const NOW = Date.parse('2026-11-22T10:00:00Z');

const requestComment = (id, hash, assigned, at, history = []) => ({
  id,
  user: { login: ENGINE[0] },
  created_at: new Date(at).toISOString(),
  updated_at: new Date(at).toISOString(),
  body: buildReviewRequest({ hash, assigned, history, config }),
});

test('no review request yet: the first review is planned from the spec pass', () => {
  const out = planRounds({ comments: [], config, engineLogins: ENGINE, editors: {}, bodyHash: 'h0', issueNumber: 1, limits: config.limits, now: NOW });
  assert.equal(out.plan.type, 'request-round');
  assert.equal(out.plan.round, 'R2');
  assert.equal(out.plan.attempt, 1);
});

test('a fresh review request with no verdict: the plan waits, and the dry-run says so', () => {
  const comments = [requestComment(1, 'h0', 'claude-a', NOW - 1000)];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h0', issueNumber: 1, limits: config.limits, now: NOW });
  assert.equal(out.rounds, 2, 'the spec round and R2');
  assert.deepEqual([out.plan.type, out.plan.reason], ['none', 'analysis.round-waiting']);
});

test('a request that went silent is retried on another identity in the plan', () => {
  const comments = [requestComment(1, 'h0', 'claude-a', NOW - 2 * 60 * 60 * 1000)];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h0', issueNumber: 1, limits: config.limits, now: NOW });
  assert.equal(out.plan.type, 'request-round');
  assert.equal(out.plan.round, 'R2');
  assert.equal(out.plan.attempt, 2);
  assert.equal(out.plan.agent, 'cursor-a');
});
