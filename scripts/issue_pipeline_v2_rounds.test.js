'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decideRound, isDown, selectType } = require('./issue_pipeline_v2_rounds');

const config = loadConfig();
const T = config.limits.reviewTimeoutMin * 60 * 1000;
const NOW = Date.parse('2026-11-22T10:00:00Z');
const FRESH = NOW - 1000; // well inside the timeout
const STALE = NOW - T - 1000; // past the timeout

/** R1: the spec pass. It produces the body `hash`. */
const spec = (hash, type = 'cursor-a', nonce = 'n0') => ({
  tier: 'a',
  kind: 'spec',
  hashIn: null,
  attempts: [{ type, nonce, startedAt: FRESH, result: 'spec', hashOut: hash }],
});

/** A review round with one attempt. `hashOut` set means the reviewer edited the body. */
const review = (tier, hashIn, type, nonce, result, hashOut = null, startedAt = FRESH) => ({
  tier,
  kind: 'review',
  hashIn,
  attempts: [{ type, nonce, startedAt, result, hashOut }],
});

test('first boot with no history waits for the spec pass', () => {
  assert.deepEqual(decideRound({ bodyHash: 'h0', rounds: [], now: NOW, config }), { type: 'none', reason: 'analysis.no-spec' });
});

test('happy path: cursor-a writes the spec, claude-a greens it, Ready after one green', () => {
  const r2 = decideRound({ bodyHash: 'h0', rounds: [spec('h0')], now: NOW, config });
  assert.equal(r2.type, 'request-round');
  assert.equal(r2.round, 'R2');
  assert.equal(r2.agent, 'claude-a', 'the other brand from cursor-a, the spec writer');
  assert.equal(r2.tier, 'a');
  assert.equal(r2.brand, 'claude');
  assert.equal(r2.fallback, false);
  const rounds = [spec('h0'), review('a', 'h0', 'claude-a', 'n2', 'green')];
  const done = decideRound({ bodyHash: 'h0', rounds, now: NOW, config });
  assert.equal(done.type, 'set-stage');
  assert.equal(done.to, 'Ready');
  assert.equal(done.row, 'analysis.converged');
});

test('red with an edit, then one green from a new cursor-a run: Ready, though cursor-a wrote the spec', () => {
  const rounds = [spec('h0'), review('a', 'h0', 'claude-a', 'n2', 'red', 'h1')];
  const r3 = decideRound({ bodyHash: 'h1', rounds, now: NOW, config });
  assert.equal(r3.type, 'request-round');
  assert.equal(r3.round, 'R3');
  assert.equal(r3.agent, 'cursor-a', 'alternation: the other brand from claude-a');
  assert.equal(r3.brand, 'cursor');
  const greened = [...rounds, review('a', 'h1', 'cursor-a', 'n3', 'green')];
  const done = decideRound({ bodyHash: 'h1', rounds: greened, now: NOW, config });
  assert.equal(done.to, 'Ready', 'one green on the rewritten body is enough; a second is not required');
  assert.equal(done.evidence.nonce, 'n3', 'the green is from a new run, not the spec run n0');
});

test('a green signed by the run that wrote the body does not converge', () => {
  const rounds = [spec('h0'), review('a', 'h0', 'claude-a', 'n2', 'red', 'h1'), review('a', 'h1', 'claude-a', 'n2', 'green')];
  const out = decideRound({ bodyHash: 'h1', rounds, now: NOW, config });
  assert.deepEqual([out.type, out.reason], ['none', 'analysis.green-by-author-ignored']);
});

test('R2 and R3 red with edits, R4 green: Ready on the fourth round', () => {
  const rounds = [
    spec('h0'),
    review('a', 'h0', 'claude-a', 'n2', 'red', 'h1'),
    review('a', 'h1', 'cursor-a', 'n3', 'red', 'h2'),
    review('a', 'h2', 'claude-a', 'n4', 'green'),
  ];
  assert.equal(decideRound({ bodyHash: 'h2', rounds, now: NOW, config }).to, 'Ready');
});

test('R2 to R4 red with edits: the normal tier is spent, so C1 starts in tier b with the other brand', () => {
  const rounds = [
    spec('h0'),
    review('a', 'h0', 'claude-a', 'n2', 'red', 'h1'),
    review('a', 'h1', 'cursor-a', 'n3', 'red', 'h2'),
    review('a', 'h2', 'claude-a', 'n4', 'red', 'h3'),
  ];
  const c1 = decideRound({ bodyHash: 'h3', rounds, now: NOW, config });
  assert.equal(c1.type, 'request-round');
  assert.equal(c1.tier, 'b');
  assert.equal(c1.round, 'C1');
  assert.equal(c1.agent, 'cursor-b', 'the author of h3 is claude-a, so cursor-b');
  assert.equal(c1.row, 'challenge.round-request');
});

test('challenge: C1 to C4 all red with edits is no-convergence; a green on C4 would be Ready', () => {
  const base = [
    spec('h0'),
    review('a', 'h0', 'claude-a', 'n2', 'red', 'h1'),
    review('a', 'h1', 'cursor-a', 'n3', 'red', 'h2'),
    review('a', 'h2', 'claude-a', 'n4', 'red', 'h3'),
  ];
  const full = [
    ...base,
    review('b', 'h3', 'cursor-b', 'n5', 'red', 'h4'),
    review('b', 'h4', 'claude-b', 'n6', 'red', 'h5'),
    review('b', 'h5', 'cursor-b', 'n7', 'red', 'h6'),
    review('b', 'h6', 'claude-b', 'n8', 'red', 'h7'),
  ];
  const blocked = decideRound({ bodyHash: 'h7', rounds: full, now: NOW, config });
  assert.deepEqual([blocked.type, blocked.reason, blocked.row], ['set-blocked', 'no-convergence', 'analysis.no-convergence']);
  const greenC4 = [...full.slice(0, -1), review('b', 'h6', 'claude-b', 'n8', 'green')];
  assert.equal(decideRound({ bodyHash: 'h6', rounds: greenC4, now: NOW, config }).to, 'Ready');
});

test('challenge alternates brands: after C1 by cursor-b, C2 is claude-b', () => {
  const rounds = [
    spec('h0'),
    review('a', 'h0', 'claude-a', 'n2', 'red', 'h1'),
    review('a', 'h1', 'cursor-a', 'n3', 'red', 'h2'),
    review('a', 'h2', 'claude-a', 'n4', 'red', 'h3'),
    review('b', 'h3', 'cursor-b', 'n5', 'red', 'h4'),
  ];
  const c2 = decideRound({ bodyHash: 'h4', rounds, now: NOW, config });
  assert.equal(c2.round, 'C2');
  assert.equal(c2.agent, 'claude-b');
  assert.equal(c2.fallback, false);
});

test('before challenge, every pick is a tier-a type whatever the round robin says', () => {
  const orders = [
    {},
    { 'cursor-a': 1, 'claude-a': 2, 'cursor-b': 3, 'claude-b': 4 },
    { 'cursor-b': 1, 'claude-b': 2, 'cursor-a': 3, 'claude-a': 4 },
  ];
  for (const lastUsed of orders) {
    for (const rounds of [[spec('h0')], [spec('h0'), review('a', 'h0', 'claude-a', 'n2', 'red', 'h1')]]) {
      const out = decideRound({ bodyHash: rounds.at(-1).attempts.at(-1).hashOut, rounds, now: NOW, lastUsed, config });
      assert.ok(['cursor-a', 'claude-a'].includes(out.agent), `pick ${out.agent}`);
    }
  }
});

test('a silent round is retried once with another identity, marked as a fallback when only the same brand is left', () => {
  const silent = { tier: 'a', kind: 'review', hashIn: 'h0', attempts: [{ type: 'claude-a', nonce: 'n2', startedAt: STALE, result: null, hashOut: null }] };
  const out = decideRound({ bodyHash: 'h0', rounds: [spec('h0'), silent], now: NOW, config });
  assert.equal(out.type, 'request-round');
  assert.equal(out.attempt, 2);
  assert.equal(out.round, 'R2', 'a retry keeps the round label');
  assert.equal(out.agent, 'cursor-a');
  assert.equal(out.brand, 'cursor');
  assert.equal(out.fallback, true, 'claude-a already tried this round, so cursor-a repeats the author brand');
});

test('two silent attempts on one round: stalled', () => {
  const twice = {
    tier: 'a',
    kind: 'review',
    hashIn: 'h0',
    attempts: [
      { type: 'claude-a', nonce: 'n2', startedAt: STALE - T, result: null, hashOut: null },
      { type: 'cursor-a', nonce: 'n3', startedAt: STALE, result: null, hashOut: null },
    ],
  };
  const out = decideRound({ bodyHash: 'h0', rounds: [spec('h0'), twice], now: NOW, config });
  assert.deepEqual([out.type, out.reason], ['set-blocked', 'stalled']);
});

test('a red without an edit holds the round on the same hash, then counts as silent after the timeout', () => {
  const hold = { tier: 'a', kind: 'review', hashIn: 'h0', attempts: [{ type: 'claude-a', nonce: 'n2', startedAt: FRESH, result: 'red', hashOut: null }] };
  const waiting = decideRound({ bodyHash: 'h0', rounds: [spec('h0'), hold], now: NOW, config });
  assert.deepEqual([waiting.type, waiting.reason], ['none', 'analysis.round-waiting']);
  const expired = { ...hold, attempts: [{ ...hold.attempts[0], startedAt: STALE }] };
  const retry = decideRound({ bodyHash: 'h0', rounds: [spec('h0'), expired], now: NOW, config });
  assert.equal(retry.type, 'request-round');
  assert.equal(retry.attempt, 2);
  assert.equal(retry.hash, 'h0', 'the rejected body stays the hash under review; nothing new is handed out');
});

test('a pending round is not asked again: a repeated watcher wake does nothing', () => {
  const pending = review('a', 'h0', 'claude-a', 'n2', null);
  const input = { bodyHash: 'h0', rounds: [spec('h0'), pending], now: NOW, config };
  const first = decideRound(input);
  assert.deepEqual([first.type, first.reason], ['none', 'analysis.round-waiting']);
  assert.deepEqual(decideRound(input), first, 'the same state gives the same answer');
});

test('a human edit mid-sequence does not reset the budget: the next round in sequence runs', () => {
  const rounds = [spec('h0'), review('a', 'h0', 'claude-a', 'n2', 'red', 'h1')];
  const out = decideRound({ bodyHash: 'h9', rounds, now: NOW, config });
  assert.equal(out.type, 'request-round');
  assert.equal(out.round, 'R3', 'R2 still counts; a human edit is not a reset');
  assert.equal(out.hash, 'h9');
  assert.equal(out.fallback, false);
});

test('a human edit while a round is open makes that round stale: the next round in sequence starts', () => {
  const open = review('a', 'h0', 'claude-a', 'n2', null);
  const out = decideRound({ bodyHash: 'h1', rounds: [spec('h0'), open], now: NOW, config });
  assert.equal(out.round, 'R3', 'the stale R2 still counts against the budget');
  assert.equal(out.hash, 'h1');
});

test('a green on an older hash does not converge after a human edit', () => {
  const rounds = [spec('h0'), review('a', 'h0', 'claude-a', 'n2', 'green')];
  const out = decideRound({ bodyHash: 'h1', rounds, now: NOW, config });
  assert.equal(out.type, 'request-round', 'the green was on h0, not on the current body');
  assert.equal(out.round, 'R3');
});

test('a down identity is skipped; the other brand repeats as a fallback', () => {
  const failed = (round, hashIn) => ({ tier: 'a', kind: 'review', hashIn, attempts: [{ type: 'cursor-a', nonce: round, startedAt: STALE, result: null, hashOut: null }] });
  const rounds = [failed('x1', 'h0'), failed('x2', 'h0')];
  assert.equal(isDown(rounds, 'a', 'cursor-a', NOW, T), true, 'two consecutive silent attempts make cursor-a down');
  assert.equal(isDown(rounds, 'a', 'claude-a', NOW, T), false);
  const pick = selectType({ config, tier: 'a', prevBrand: 'claude', excluded: [], rounds, lastUsed: {}, now: NOW, timeoutMs: T });
  assert.deepEqual([pick.agent, pick.fallback], ['claude-a', true]);
});

test('a single brand startable: fallback rounds repeat it; no candidate at all stalls', () => {
  const cursorOnly = { ...config, launchRunners: ['cursor'] };
  const out = decideRound({ bodyHash: 'h0', rounds: [spec('h0')], now: NOW, config: cursorOnly });
  assert.equal(out.type, 'request-round');
  assert.equal(out.agent, 'cursor-a');
  assert.equal(out.fallback, true);
  assert.equal(out.brand, 'cursor');
  const none = decideRound({ bodyHash: 'h0', rounds: [spec('h0')], now: NOW, config: { ...config, launchRunners: [] } });
  assert.deepEqual([none.type, none.reason], ['set-blocked', 'stalled']);
});

test('least recently used decides when the author is a human (no brand to alternate from)', () => {
  // A human edit to h0 gives h9: no run wrote it, so every tier-a id is eligible and the least recent wins.
  const out = decideRound({ bodyHash: 'h9', rounds: [spec('h0')], now: NOW, lastUsed: { 'cursor-a': NOW - 1, 'claude-a': NOW - 5 }, config });
  assert.equal(out.agent, 'claude-a');
  assert.equal(out.fallback, false);
  assert.equal(out.round, 'R2');
});

test('a holder outside the tier pool is reassigned at once, not after the timeout', () => {
  // claude-b (tier b) holds an open tier-a round: it is not waited for.
  const held = { tier: 'a', kind: 'review', hashIn: 'h0', attempts: [{ type: 'claude-b', nonce: 'n2', startedAt: FRESH, result: null, hashOut: null }] };
  const out = decideRound({ bodyHash: 'h0', rounds: [spec('h0'), held], now: NOW, config });
  assert.equal(out.type, 'request-round');
  assert.equal(out.row, 'analysis.round-retry');
  assert.equal(out.reason, 'not-startable');
  assert.equal(out.agent, 'claude-a', 'the other brand from cursor-a, the spec writer');
  assert.equal(out.attempt, 2);
});

test('a green from outside the tier pool does not converge; the round is retried with a pool identity', () => {
  // #2533 in the P4 re-run: claude-b (tier b) greened a tier-a round. That is not agreement.
  const rounds = [spec('h0', 'cursor-a'), review('a', 'h0', 'claude-b', 'n2', 'green')];
  const out = decideRound({ bodyHash: 'h0', rounds, now: NOW, config });
  assert.notEqual(out.type, 'set-stage', 'no Ready on a non-pool green');
  assert.equal(out.type, 'request-round');
  assert.equal(out.round, 'R2', 'the same round, retried');
  assert.equal(out.agent, 'claude-a', 'a pool identity, the other brand from cursor-a');
  assert.equal(out.reason, 'not-startable');
});
