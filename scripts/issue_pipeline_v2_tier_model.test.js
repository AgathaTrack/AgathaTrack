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
