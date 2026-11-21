'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig, isSharedActsAs } = require('./issue_pipeline_v2_config');
const { votesOnRequest } = require('./issue_pipeline_v2_review');
const { STAGE_PROMPTS, STAGE_PROMPTS_SIGNED, stagePromptsForConfig } = require('./issue_pipeline_v2_launch');

const config = loadConfig();
const byId = (id) => config.agents.find((a) => a.id === id);
const CREATED = '2026-11-22T10:00:00Z';
const request = { comment: { created_at: CREATED }, parsed: { hash: 'h1' } };
const reaction = (login, content) => ({ user: { login }, content, created_at: '2026-11-22T10:05:00Z' });

test('P2: claude-b is tier b on opus, and the claude pair shares one login', () => {
  assert.equal(byId('claude-b').tier, 'b');
  assert.equal(byId('claude-b').actsAs, 'pawpet-claude');
  assert.equal(byId('claude-b').model, 'claude-opus-5-5');
  assert.equal(byId('claude-b').effort, 'medium');
  assert.equal(isSharedActsAs(config, 'pawpet-claude'), true);
});

test('P2: both Claude identities get the signed-verdict prompts, not the reaction prompts', () => {
  assert.equal(stagePromptsForConfig(config, byId('claude-a')), STAGE_PROMPTS_SIGNED);
  assert.equal(stagePromptsForConfig(config, byId('claude-b')), STAGE_PROMPTS_SIGNED);
  assert.notEqual(STAGE_PROMPTS['To do'], STAGE_PROMPTS_SIGNED['To do']);
});

test('P2: a 👍 from a shared login is not a vote; only signed verdicts name the voter', () => {
  const votes = votesOnRequest({
    request,
    reactions: [reaction('pawpet-claude', '+1'), reaction('pawpet-bot', '+1')],
    config,
  });
  assert.deepEqual(votes, [], 'shared-login reactions must not count');
});

test('P2: a 👍 from a login with one identity still counts', () => {
  const solo = validateConfig({
    agents: [
      { id: 'cursor-a', actsAs: 'pawpet-bot', runner: 'cursor', methods: ['PR'], tier: 'a' },
      { id: 'claude-a', actsAs: 'pawpet-claude', runner: 'claude', methods: ['PR'], tier: 'a' },
    ],
    engine: { logins: ['pawpet-engine'] },
    launchRunners: ['cursor', 'claude'],
    limits: config.limits,
    aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
  });
  const votes = votesOnRequest({ request, reactions: [reaction('pawpet-claude', '+1')], config: solo });
  assert.deepEqual(votes.map((v) => [v.login, v.vote]), [['pawpet-claude', 'up']]);
});

test('P2: a reaction older than the request is not a vote, on either path', () => {
  const old = { user: { login: 'pawpet-claude' }, content: '+1', created_at: '2026-11-22T09:00:00Z' };
  const solo = validateConfig({
    agents: [
      { id: 'cursor-a', actsAs: 'pawpet-bot', runner: 'cursor', methods: ['PR'], tier: 'a' },
      { id: 'claude-a', actsAs: 'pawpet-claude', runner: 'claude', methods: ['PR'], tier: 'a' },
    ],
    engine: { logins: ['pawpet-engine'] },
    launchRunners: ['cursor', 'claude'],
    limits: config.limits,
    aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
  });
  assert.deepEqual(votesOnRequest({ request, reactions: [old], config: solo }), []);
});
