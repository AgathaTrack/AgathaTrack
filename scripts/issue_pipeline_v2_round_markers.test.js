'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { buildRoundMarker, parseRoundMarker, roundFor } = require('./issue_pipeline_v2_round_markers');

const config = loadConfig();
const fields = {
  stage: { id: 1, name: 'Stage', options: ['To do', 'In analysis', 'Ready', 'Done'] },
  blocked: { id: 2, name: 'Blocked', options: ['stalled', 'no-convergence'] },
  attempts: { id: 3, name: 'Attempts', options: [] },
};
const ctx = (extra = {}) => ({
  owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config, fields,
  parsed: { attempts: 0 }, assignees: ['human'], counters: {}, facts: {}, dryRun: true, ...extra,
});

/** Every comment the action would post, as the marker bodies it contains. */
const markersIn = (result) =>
  result.calls
    .filter((c) => c.method === 'POST' && /\/comments$/.test(c.path))
    .map((c) => parseRoundMarker(c.body.body))
    .filter(Boolean);

test('round labels: R2 to R4 in tier a, C1 to C4 in tier b, none for an unknown review number', () => {
  assert.deepEqual(roundFor(1), { tier: 'a', round: 'R2' });
  assert.deepEqual(roundFor(3), { tier: 'a', round: 'R4' });
  assert.deepEqual(roundFor(4), { tier: 'b', round: 'C1' });
  assert.deepEqual(roundFor(7), { tier: 'b', round: 'C4' });
  assert.equal(roundFor(0), null);
});

test('a marker round-trips through the parser with every field', () => {
  const body = buildRoundMarker({
    event: 'fail', round: 'R3', tier: 'a', identity: 'cursor-a', brand: 'cursor', attempt: 2,
    fallback: true, hash: 'abc123', author: 'claude-a', failure: 'timeout', runId: 'run-9', nonce: 'ff00',
  });
  const parsed = parseRoundMarker(body);
  assert.equal(parsed.event, 'fail');
  assert.equal(parsed.round, 'R3');
  assert.equal(parsed.identity, 'cursor-a');
  assert.equal(parsed.attempt, 2);
  assert.equal(parsed.fallback, true);
  assert.equal(parsed.failure, 'timeout');
  assert.equal(parsed.runId, 'run-9');
  assert.match(body, /Round R3, attempt 2: attempt failed: timeout, cursor-a \(cursor\)\./);
});

test('a fail marker needs a known failure class, and an unknown event is refused', () => {
  assert.throws(() => buildRoundMarker({ event: 'fail', identity: 'cursor-a' }), /failure class/);
  assert.throws(() => buildRoundMarker({ event: 'fail', identity: 'cursor-a', failure: 'bad' }), /failure class/);
  assert.throws(() => buildRoundMarker({ event: 'wobble' }), /unknown event/);
});

test('attribute values are cleaned: no quote or angle bracket can close the marker early', () => {
  const body = buildRoundMarker({ event: 'close', identity: 'cursor-a--> <!--x', verdict: 'converged' });
  assert.equal((body.match(/-->/g) || []).length, 1);
});

test('a forced timeout on a review writes a fail marker for the silent identity, then a start for the next', async () => {
  const facts = {
    stage: 'In analysis',
    bodyHash: 'h1',
    review: { requestedHash: 'h1', commentId: 77, assignedTo: 'claude-a', timedOut: [], requestedAt: 0 },
    roundPlan: { reviews: 1, derived: [] },
  };
  const result = await applyAction({
    action: { type: 'reassign', stage: 'In analysis', agent: 'cursor-a', attempts: 1, failureClass: 'timeout' },
    ctx: ctx({ facts, config }),
  });
  const markers = markersIn(result);
  const fail = markers.find((m) => m.event === 'fail');
  assert.equal(fail.failure, 'timeout', 'the forced timeout is classed as timeout');
  assert.equal(fail.identity, 'claude-a', 'the identity that went silent');
  assert.equal(fail.round, 'R2');
  assert.equal(fail.attempt, 1);
  const start = markers.find((m) => m.event === 'start');
  assert.equal(start.identity, 'cursor-a');
  assert.equal(start.attempt, 2, 'the retry is attempt 2');
  assert.equal(start.round, 'R2', 'a retry keeps the round label');
  assert.equal(start.brand, 'cursor');
});

test('a forced ring failure writes a ring-failed marker at the ring, and no start marker', async () => {
  const facts = { stage: 'In analysis', bodyHash: 'h1', roundPlan: { reviews: 0, derived: [] } };
  const posted = [];
  const result = await applyAction({
    action: { type: 'request-review', hash: 'h1', agent: 'claude-a' },
    ctx: ctx({
      facts,
      config,
      dryRun: false,
      restFn: async (method, path, token, body) => {
        if (method === 'POST' && /\/comments$/.test(path)) posted.push(body.body);
        return { id: 1 };
      },
      launchFn: async () => {
        throw new Error('dispatch 422');
      },
    }),
  });
  const markers = posted.map((b) => parseRoundMarker(b)).filter(Boolean);
  const fail = markers.find((m) => m.event === 'fail');
  assert.equal(fail.failure, 'ring-failed');
  assert.equal(fail.identity, 'claude-a');
  assert.equal(fail.round, 'R2');
  assert.equal(markers.some((m) => m.event === 'start'), false);
  assert.ok(result.applied.some((a) => a.startsWith('doorbell-failed:claude-a')));
});

test('a ring that starts a run writes a start marker with the run id and the nonce', async () => {
  const facts = { stage: 'To do', bodyHash: 'h0' };
  const result = await applyAction({
    action: { type: 'request-spec', agent: 'cursor-a' },
    ctx: ctx({ facts, config }),
  });
  const start = markersIn(result).find((m) => m.event === 'start');
  assert.equal(start.round, 'R1');
  assert.equal(start.identity, 'cursor-a');
  assert.equal(start.attempt, 1);
  assert.equal(start.runId, 'dry-run');
  assert.ok(start.nonce && /^[a-f0-9]+$/.test(start.nonce), 'the run nonce is recorded for audit');
});

test('convergence closes the current round with the approving identity', async () => {
  const facts = { stage: 'In analysis', bodyHash: 'h2', roundPlan: { reviews: 3, derived: [] } };
  const result = await applyAction({
    action: { type: 'set-stage', to: 'Ready', row: 'analysis.converged', evidence: { hash: 'h2', approvedBy: ['cursor-a'] } },
    ctx: ctx({ facts, config }),
  });
  const close = markersIn(result).find((m) => m.event === 'close');
  assert.deepEqual([close.round, close.tier, close.identity, close.verdict], ['R4', 'a', 'cursor-a', 'converged']);
});

test('the spec pass closes R1 with the spec writer', async () => {
  const facts = { stage: 'To do', bodyHash: 'h0', spec: { assignedTo: 'cursor-a' } };
  const result = await applyAction({
    action: { type: 'set-stage', to: 'In analysis', row: 'todo.dor-pass' },
    ctx: ctx({ facts, config }),
  });
  const close = markersIn(result).find((m) => m.event === 'close');
  assert.deepEqual([close.round, close.identity, close.verdict], ['R1', 'cursor-a', 'spec']);
});

test('a blocked round closes with the blocking reason on the current round label', async () => {
  const facts = { stage: 'In analysis', review: { requestedHash: 'h9' }, roundPlan: { reviews: 6, derived: [] } };
  const result = await applyAction({
    action: { type: 'set-blocked', reason: 'no-convergence', row: 'analysis.no-convergence' },
    ctx: ctx({ facts, config }),
  });
  const close = markersIn(result).find((m) => m.event === 'close');
  assert.deepEqual([close.round, close.tier, close.verdict], ['C3', 'b', 'no-convergence']);
});
