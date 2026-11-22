'use strict';

// The live In analysis action is the round plan (PIPE-V2-D-REV3-007, wired on this branch).
// These tests go through decide() and check the action the apply path receives.

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('./issue_pipeline_v2_decide');
const { loadConfig } = require('./issue_pipeline_v2_config');

const config = loadConfig();
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-22T10:00:00Z');
const T = config.limits.reviewTimeoutMin * MIN;

/** Round records: the spec pass by `specBy`, then one review on h0 by `reviewer`. */
const specRound = (hash = 'h0', by = 'cursor-a') => ({
  tier: 'a', kind: 'spec', hashIn: null,
  attempts: [{ type: by, nonce: 'n0', startedAt: null, result: 'spec', hashOut: hash }],
});
const reviewRound = (hashIn, attempts) => ({ tier: 'a', kind: 'review', hashIn, attempts });

const live = (over = {}) =>
  decide({
    mode: 'on', now: NOW, onBoard: true, labels: ['pipeline-beta'], stage: 'In analysis', blocked: '',
    bodyHash: 'h0', wip: 0, totalVotes: 0, roundRobinOrder: config.agents.map((a) => a.id), ...over,
  }, config);

test('a verified green from another run converges the body: Ready on one green', () => {
  const action = live({
    rounds: [specRound(), reviewRound('h0', [{ type: 'claude-a', nonce: 'n2', startedAt: NOW - MIN, result: 'green', hashOut: null }])],
  });
  assert.equal(action.type, 'set-stage');
  assert.equal(action.to, 'Ready');
  assert.equal(action.row, 'analysis.converged');
  assert.equal(action.evidence.approvedBy, 'claude-a');
});

test('a red that edits the body hands the new hash to the other brand as a new request', () => {
  const action = live({
    bodyHash: 'h1',
    rounds: [specRound('h0', 'cursor-a'), reviewRound('h0', [{ type: 'claude-a', nonce: 'n2', startedAt: NOW - MIN, result: 'red', hashOut: 'h1' }])],
  });
  assert.equal(action.type, 'request-review');
  assert.equal(action.hash, 'h1');
  assert.equal(action.agent, 'cursor-a', 'the other brand from claude-a');
  assert.equal(action.round, 'R3');
  assert.equal(action.fallback, false);
});

test('a silent reviewer past the timeout is reassigned, with a timeout failure class', () => {
  const action = live({
    rounds: [specRound('h0', 'cursor-a'), reviewRound('h0', [{ type: 'claude-a', nonce: null, startedAt: NOW - T - MIN, result: null, hashOut: null }])],
  });
  assert.equal(action.type, 'reassign');
  assert.equal(action.stage, 'In analysis');
  assert.equal(action.failureClass, 'timeout');
  assert.equal(action.attempts, 1, 'one failed attempt so far');
});

test('busy doubles the silence window: a doorbell that is still running is not reassigned at one timeout', () => {
  const rounds = [specRound('h0', 'cursor-a'), reviewRound('h0', [{ type: 'claude-a', nonce: null, startedAt: NOW - T - 5 * MIN, result: null, hashOut: null }])];
  assert.equal(live({ rounds }).type, 'reassign', 'not busy: reassigned after one timeout');
  const held = live({ rounds, labels: ['pipeline-beta', 'busy'] });
  assert.equal(held.type, 'none');
  assert.equal(held.reason, 'analysis.round-waiting');
});

test('a doorbell that failed to start is reassigned at once, not after the timeout', () => {
  const action = live({
    rounds: [specRound('h0', 'cursor-a'), reviewRound('h0', [{ type: 'claude-a', nonce: null, startedAt: NOW - MIN, result: null, hashOut: null }])],
    review: { requestedHash: 'h0', requestedAt: NOW - MIN, assignedTo: 'claude-a', ringFailed: true },
  });
  assert.equal(action.type, 'reassign');
  assert.equal(action.failureClass, 'ring-failed');
});

test('a queued doorbell is rung again, not counted as a failed attempt', () => {
  const action = live({
    labels: ['pipeline-beta', 'queued'],
    rounds: [specRound('h0', 'cursor-a'), reviewRound('h0', [{ type: 'claude-a', nonce: null, startedAt: NOW - MIN, result: null, hashOut: null }])],
    review: { requestedHash: 'h0', requestedAt: NOW - MIN, assignedTo: 'claude-a' },
  });
  assert.equal(action.type, 'ring-doorbell');
  assert.equal(action.agent, 'claude-a');
  assert.equal(action.row, 'analysis.runner-queued');
});

test('the first review after the spec pass is requested from the other brand', () => {
  const action = live({ rounds: [specRound('h0', 'cursor-a')] });
  assert.equal(action.type, 'request-review');
  assert.equal(action.agent, 'claude-a');
  assert.equal(action.round, 'R2');
});

test('the board cursor sets the order: the least recent identity of the wanted brand is picked', () => {
  // The board last assigned cursor-a. With the author on the claude brand, the wanted brand is cursor.
  const action = live({
    roundRobinAfter: 'cursor-a',
    rounds: [specRound('h0', 'claude-a')],
  });
  assert.equal(action.agent, 'cursor-a');
});

test('a human edit makes the open round stale; the next round in sequence is requested', () => {
  const action = live({
    bodyHash: 'h9',
    rounds: [specRound('h0', 'cursor-a'), reviewRound('h0', [{ type: 'claude-a', nonce: null, startedAt: NOW - MIN, result: null, hashOut: null }])],
  });
  assert.equal(action.type, 'request-review');
  assert.equal(action.hash, 'h9');
  assert.equal(action.round, 'R3');
});

test('a body with no round records (planning could not run) is not decided silently', () => {
  // The tick throws before decide() when planning fails; with no records at all, decide() waits.
  const action = live({ rounds: [] });
  assert.equal(action.type, 'none');
  assert.equal(action.reason, 'analysis.no-spec');
});
