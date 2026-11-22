'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig } = require('./issue_pipeline_v2_config');
const { buildClaudeArgs } = require('./pipeline_claude_run_lib');

const base = (over = {}) => ({
  agents: [
    { id: 'cursor-a', actsAs: 'pawpet-bot', runner: 'cursor', methods: ['PR'], tier: 'a' },
    { id: 'claude-a', actsAs: 'pawpet-claude', runner: 'claude', methods: ['PR'], tier: 'a' },
  ],
  engine: { logins: ['pawpet-engine'] },
  launchRunners: ['cursor', 'claude'],
  limits: loadConfig().limits,
  aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
  ...over,
});

test('config: the committed file gives claude-a tier a, haiku and high effort; cursor-b is tier b', () => {
  const config = loadConfig();
  const byId = Object.fromEntries(config.agents.map((a) => [a.id, a]));
  assert.equal(byId['claude-a'].tier, 'a');
  assert.equal(byId['claude-a'].model, 'claude-haiku-5-5');
  assert.equal(byId['claude-a'].effort, 'high');
  assert.equal(byId['cursor-a'].tier, 'a');
  assert.equal(byId['cursor-b'].tier, 'b');
  assert.equal(byId['cursor-b'].model, 'grok-4.7-medium', 'existing Cursor models are unchanged');
});

test('config: tier, effort and model are validated; a typo is reported, not ignored', () => {
  assert.doesNotThrow(() => validateConfig(base()));
  const cfg = base();
  cfg.agents[0].tier = 'c';
  cfg.agents[1].effort = 'extreme';
  cfg.agents[1].model = 'claude-haiku-5-5; rm -rf /';
  assert.throws(() => validateConfig(cfg), (error) =>
    /tier must be a or b/.test(error.message) &&
    /effort must be low, medium or high/.test(error.message) &&
    /model must contain only/.test(error.message),
  );
});

test('config: non-string tier, effort or model fails at load instead of being dropped', () => {
  const cfg = base();
  cfg.agents[1].model = 123;
  assert.throws(() => validateConfig(cfg), /model must be a string/);
  cfg.agents[1].model = 'claude-haiku-5-5';
  cfg.agents[1].tier = 1;
  assert.throws(() => validateConfig(cfg), /tier must be a string/);
});

test('config: fields are optional, so existing entries without them stay valid', () => {
  const cfg = base();
  for (const agent of cfg.agents) {
    delete agent.tier;
  }
  assert.doesNotThrow(() => validateConfig(cfg));
});

test('claude args: the model flag comes from the identity; no model means no flag', () => {
  assert.equal(
    buildClaudeArgs({ model: 'claude-haiku-5-5' }),
    '--allowedTools Bash,Edit,Write,Read,Glob,Grep --model claude-haiku-5-5',
  );
  assert.equal(buildClaudeArgs({}), '--allowedTools Bash,Edit,Write,Read,Glob,Grep');
  assert.equal(buildClaudeArgs(undefined), '--allowedTools Bash,Edit,Write,Read,Glob,Grep');
});

test('claude args: a model name that is not a plain token is refused, never passed to the CLI', () => {
  assert.throws(() => buildClaudeArgs({ model: '--dangerously-skip-permissions' }), /refusing unsafe model name/);
  assert.throws(() => buildClaudeArgs({ model: 'a b' }), /refusing unsafe model name/);
});

// --- Review pool is tier a until the challenge tier exists (review process v3 §7, P4) -----------

const { reviewPoolIds } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');

test('pool: spec and review pickup never draw from tier b before the challenge tier', () => {
  const cfg = loadConfig();
  assert.deepEqual(reviewPoolIds(cfg).sort(), ['claude-a', 'cursor-a']);
  const order = cfg.agents.map((a) => a.id);
  const now = Date.parse('2026-11-22T10:00:00Z');
  const picks = new Set();
  for (const after of [undefined, ...order]) {
    const spec = decide(
      { mode: 'on', now, onBoard: true, labels: ['pipeline-beta'], stage: 'To do', blocked: '', bodyHash: 'h1', totalVotes: 0, wip: 0,
        roundRobinAfter: after, roundRobinOrder: order },
      cfg,
    );
    assert.equal(spec.type, 'request-spec');
    picks.add(spec.agent);
  }
  assert.deepEqual([...picks].sort(), ['claude-a', 'cursor-a'], 'the spec ring visits only the tier-a types');
});

test('pool: a tier-b assignee on an open review is reassigned, not waited for', () => {
  const cfg = loadConfig();
  const now = Date.parse('2026-11-22T10:00:00Z');
  const requestedAt = now - 1000; // well inside reviewTimeoutMin
  const d = decide(
    { mode: 'on', now, onBoard: true, labels: ['pipeline-beta'], stage: 'In analysis', blocked: '', bodyHash: 'h1', totalVotes: 0, wip: 0,
      lastBodyEditor: 'pawpet-bot', editorAgentId: 'cursor-a',
      review: { requestedHash: 'h1', requestedAt, assignedTo: 'cursor-b', timedOut: [], votes: [] } },
    cfg,
  );
  assert.notEqual(d.agent, 'cursor-b');
  assert.notEqual(d.agent, 'claude-b');
  assert.equal(d.type, 'reassign', 'a held tier-b assignee is not in the pool, so it is replaced at once');
});

// --- Queued and wake paths keep the tier-a pool (PR review of the tier-a slice) -----------------

const NOW_T = Date.parse('2026-11-22T10:00:00Z');
const ctxFacts = (over = {}) => ({
  mode: 'on', now: NOW_T, onBoard: true, labels: ['pipeline-beta'], stage: 'In analysis', blocked: '',
  bodyHash: 'h1', totalVotes: 0, wip: 0, ...over,
});

test('pool: a queued tier-b review assignee is reassigned, not rung again', () => {
  const cfg = loadConfig();
  const d = decide(
    ctxFacts({
      labels: ['pipeline-beta', 'queued'],
      lastBodyEditor: 'pawpet-bot', editorAgentId: 'cursor-a',
      review: { requestedHash: 'h1', requestedAt: NOW_T - 1000, assignedTo: 'cursor-b', timedOut: [], votes: [] },
    }),
    cfg,
  );
  assert.notEqual(d.type, 'ring-doorbell', 'a tier-b id on the queue is not a normal-pool doorbell');
  assert.equal(d.type, 'reassign');
  assert.ok(reviewPoolIds(cfg).includes(d.agent), `reassigned to a tier-a id, got ${d.agent}`);
});

test('pool: a queued tier-b spec assignee is reassigned, not rung again', () => {
  const cfg = loadConfig();
  const d = decide(
    ctxFacts({
      stage: 'To do', labels: ['pipeline-beta', 'queued'],
      spec: { requestedAt: NOW_T - 1000, assignedTo: 'claude-b', timedOut: [] },
    }),
    cfg,
  );
  assert.notEqual(d.type, 'ring-doorbell');
  assert.equal(d.type, 'reassign');
  assert.ok(reviewPoolIds(cfg).includes(d.agent));
});

test('pool: a human reply that wakes To do or In analysis never picks a tier-b id', () => {
  const cfg = loadConfig();
  const order = cfg.agents.map((a) => a.id);
  for (const stage of ['To do', 'In analysis']) {
    for (const after of [undefined, ...order]) {
      const d = decide(
        ctxFacts({
          stage, blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 'c1', wokenFor: [],
          roundRobinAfter: after, roundRobinOrder: order,
          spec: { requestedAt: NOW_T, assignedTo: 'cursor-b' }, review: { requestedHash: 'h1', requestedAt: NOW_T, assignedTo: 'claude-b', votes: [] },
        }),
        cfg,
      );
      if (d.type === 'wake-stage-agent') {
        assert.ok(['cursor-a', 'claude-a'].includes(d.agent), `${stage}: woke ${d.agent}`);
      }
    }
  }
});

test('pool: a human reply on a blocked In Main may still wake a tier-b id (full startable set)', () => {
  const cfg = loadConfig();
  const order = cfg.agents.map((a) => a.id);
  const picks = new Set();
  for (const after of [undefined, ...order]) {
    const d = decide(
      ctxFacts({
        stage: 'In Main', blocked: 'decision', humanCommentSinceBlock: true, humanCommentId: 'c1', wokenFor: [],
        roundRobinAfter: after, roundRobinOrder: order, delivery: { lastMergeSha: 'm1' },
      }),
      cfg,
    );
    if (d.type === 'wake-stage-agent') picks.add(d.agent);
  }
  assert.ok([...picks].some((id) => id === 'cursor-b' || id === 'claude-b'), `In Main picks: ${[...picks]}`);
});

test('pool: intent review keeps the full startable set for its queued retry', () => {
  const cfg = loadConfig();
  const d = decide(
    ctxFacts({
      stage: 'In Main', labels: ['pipeline-beta', 'queued'], delivery: { lastMergeSha: 'm1' },
      intentReview: { requested: true, agent: 'cursor-b', requestedAt: NOW_T - 1000 },
    }),
    cfg,
  );
  assert.equal(d.type, 'ring-doorbell', 'intent review is not tier-a-only, so its queued b-id is re-rung');
  assert.equal(d.agent, 'cursor-b');
});
