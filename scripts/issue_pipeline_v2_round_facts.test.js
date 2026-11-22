'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decideRound } = require('./issue_pipeline_v2_rounds');
const { deriveRoundRecords } = require('./issue_pipeline_v2_round_facts');

const config = loadConfig();
const NOW = Date.parse('2026-11-22T10:00:00Z');
const T0 = NOW - 60 * 60 * 1000; // an hour ago: any timeout has long expired
const spec = { author: 'cursor-a', hash: 'h0' };

test('spec pass plus one green review: the derived rounds converge through decideRound', () => {
  const rounds = deriveRoundRecords({
    spec,
    requests: [{ hash: 'h0', assigned: 'claude-a', history: [], at: T0 }],
    verdicts: [{ agentId: 'claude-a', value: 'up', hash: 'h0', nonce: 'n2', at: T0 + 1000 }],
    launches: [],
    bodyHash: 'h0',
  });
  assert.deepEqual(rounds.map((r) => [r.tier, r.kind]), [['a', 'spec'], ['a', 'review']]);
  const out = decideRound({ bodyHash: 'h0', rounds, now: NOW, config });
  assert.equal(out.to, 'Ready');
  assert.equal(out.evidence.nonce, 'n2');
});

test('red with an edit: the next request is the produced hash, authored by the red run', () => {
  const rounds = deriveRoundRecords({
    spec,
    requests: [
      { hash: 'h0', assigned: 'claude-a', history: [], at: T0 },
      { hash: 'h1', assigned: 'cursor-a', history: [], at: T0 + 5000 },
    ],
    verdicts: [{ agentId: 'claude-a', value: 'down', hash: 'h0', nonce: 'n2', at: T0 + 1000 }],
    launches: [],
    bodyHash: 'h1',
  });
  assert.equal(rounds[1].attempts[0].hashOut, 'h1');
  // R3 was already asked of cursor-a on h1, and that run went silent, so R3 is retried on another id.
  const out = decideRound({ bodyHash: 'h1', rounds, now: NOW, config });
  assert.equal(out.type, 'request-round');
  assert.equal(out.round, 'R3');
  assert.equal(out.attempt, 2);
  assert.equal(out.agent, 'claude-a', 'cursor-a already tried R3; the author of h1 is claude-a, so only claude-a is left, as a fallback');
  assert.equal(out.fallback, true);
});

test('a red with the body still on the same hash holds the round rather than handing it on', () => {
  const rounds = deriveRoundRecords({
    spec,
    requests: [{ hash: 'h0', assigned: 'claude-a', history: [], at: NOW - 1000 }],
    verdicts: [{ agentId: 'claude-a', value: 'down', hash: 'h0', nonce: 'n2', at: NOW - 500 }],
    launches: [],
    bodyHash: 'h0',
  });
  assert.equal(rounds[1].attempts[0].hashOut, null, 'no edit, so nothing was produced');
  const out = decideRound({ bodyHash: 'h0', rounds, now: NOW, config });
  assert.equal(out.reason, 'analysis.round-waiting');
});

test('attempts that went silent appear as silent before the current one', () => {
  const rounds = deriveRoundRecords({
    spec,
    requests: [{ hash: 'h0', assigned: 'claude-a', history: ['cursor-a'], at: T0 }],
    verdicts: [],
    launches: [{ agentId: 'claude-a', nonce: 'n9', at: T0 + 10 }],
    bodyHash: 'h0',
  });
  const attempts = rounds[1].attempts;
  assert.deepEqual(attempts.map((a) => [a.type, a.result]), [['cursor-a', 'silent'], ['claude-a', null]]);
  assert.equal(attempts[1].nonce, 'n9', 'the current run is identified by its launch record');
});

test('a human edit with no verdict makes the open round stale: the next round starts with no brand', () => {
  const rounds = deriveRoundRecords({
    spec,
    requests: [{ hash: 'h0', assigned: 'claude-a', history: [], at: T0 }],
    verdicts: [],
    launches: [],
    bodyHash: 'h9',
  });
  const out = decideRound({ bodyHash: 'h9', rounds, now: NOW, config });
  assert.equal(out.round, 'R3', 'the stale R2 still counts against the budget');
  assert.equal(out.hash, 'h9');
  assert.equal(out.fallback, false, 'a human author has no brand, so no fallback');
});

test('the fourth review onwards is tier b; the budget follows the request count', () => {
  const requests = ['h0', 'h1', 'h2', 'h3'].map((hash, i) => ({
    hash,
    assigned: i % 2 ? 'cursor-a' : 'claude-a',
    history: [],
    at: T0 + i * 1000,
  }));
  const verdicts = requests.slice(0, 3).map((r, i) => ({ agentId: r.assigned, value: 'down', hash: r.hash, nonce: `n${i}`, at: T0 + i * 1000 + 500 }));
  const rounds = deriveRoundRecords({ spec, requests, verdicts, launches: [], bodyHash: 'h3' });
  assert.deepEqual(rounds.slice(1).map((r) => r.tier), ['a', 'a', 'a', 'b']);
  const out = decideRound({ bodyHash: 'h3', rounds, now: NOW, config });
  assert.equal(out.tier, 'b');
  assert.equal(out.round, 'C1');
});

test('no spec record: no rounds yet, and decideRound waits', () => {
  const rounds = deriveRoundRecords({ spec: null, requests: [], verdicts: [], launches: [], bodyHash: 'h0' });
  assert.deepEqual(rounds, []);
  assert.equal(decideRound({ bodyHash: 'h0', rounds, now: NOW, config }).reason, 'analysis.no-spec');
});
