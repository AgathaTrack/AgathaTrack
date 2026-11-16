'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideReviewHandoff } = require('./issue_pipeline_review');

const baseState = {
  round: 1,
  body_sha: 'abc',
  verdicts: { 'pawpet-claude': 'green' },
  last_assignee: 'pawpet-claude',
};

test('green with unchanged body and peer green converges to Ready', () => {
  const plan = decideReviewHandoff({
    state: baseState,
    liveBodySha: 'abc',
    reviewer: 'pawpet-bot',
    verdict: 'green',
    bodyEditedThisRound: false,
  });
  assert.equal(plan.kind, 'converged');
  assert.equal(plan.status, 'Ready');
  assert.ok(plan.converged_at);
});

test('green with body edit continues to other agent', () => {
  const plan = decideReviewHandoff({
    state: baseState,
    liveBodySha: 'def',
    reviewer: 'pawpet-bot',
    verdict: 'green',
    bodyEditedThisRound: true,
  });
  assert.equal(plan.kind, 'continue-analysis');
  assert.equal(plan.assignee, 'pawpet-claude');
});

test('converging green is checked before round cap', () => {
  const plan = decideReviewHandoff({
    state: { round: 4, body_sha: 'x', verdicts: { 'pawpet-claude': 'green' } },
    liveBodySha: 'x',
    reviewer: 'pawpet-bot',
    verdict: 'green',
    bodyEditedThisRound: false,
    roundCap: 6,
  });
  assert.equal(plan.kind, 'converged');
});

test('round cap triggers needs-owner', () => {
  const plan = decideReviewHandoff({
    state: { round: 5, body_sha: 'x', verdicts: {} },
    liveBodySha: 'x',
    reviewer: 'pawpet-bot',
    verdict: 'red',
    bodyEditedThisRound: false,
    roundCap: 6,
  });
  assert.equal(plan.kind, 'needs-owner');
  assert.equal(plan.owner_reason, 'no-convergence');
});