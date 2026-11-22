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

// --- verify step: a shared login must not let a sibling identity stand in for this run ---------

const { runEvidence } = require('./pipeline_claude_run_lib');
const { verify } = require('./pipeline_claude_verify');

const NONCE = 'ab'.repeat(16);
const SINCE = Date.parse('2026-11-22T10:00:00Z');
const AFTER = '2026-11-22T10:05:00Z';
const verdictBy = (agent, nonce = NONCE, id = 1) => ({
  id,
  user: { login: 'pawpet-claude' },
  created_at: AFTER,
  body: `<!-- v2:verdict agent=${agent} nonce=${nonce} kind=spec hash=h1 value=up sig=x -->`,
});
const sharedRun = (comments, reactions = []) =>
  runEvidence({ comments, reactions, actsAs: 'pawpet-claude', agentId: 'claude-a', nonce: NONCE, shared: true, sinceMs: SINCE });

test('P2 verify: a shared login counts only the run\'s own verdict', () => {
  assert.equal(sharedRun([verdictBy('claude-a')]).ok, true, 'its own verdict');
  assert.equal(sharedRun([verdictBy('claude-b')]).ok, false, 'a sibling identity on the same login');
  assert.equal(sharedRun([verdictBy('claude-a', 'cd'.repeat(16))]).ok, false, 'a verdict from another run');
});

test('P2 verify: a shared login gets no evidence from reactions or plain comments', () => {
  const reaction = { user: { login: 'pawpet-claude' }, content: '+1', created_at: AFTER };
  assert.equal(sharedRun([], [reaction]).ok, false, 'a reaction cannot name the run');
  const plain = { id: 9, user: { login: 'pawpet-claude' }, created_at: AFTER, body: 'hello' };
  assert.equal(sharedRun([plain]).ok, false, 'a comment that does not name the run');
});

test('P2 verify: a shared login without a run identity or nonce fails closed', () => {
  const result = runEvidence({ comments: [verdictBy('claude-a')], reactions: [], actsAs: 'pawpet-claude', agentId: 'claude-a', nonce: '', shared: true, sinceMs: SINCE });
  assert.equal(result.ok, false);
});

test('P2 verify: verify() on the shared pair ignores a sibling\'s verdict end to end', async () => {
  const request = { id: 7, user: { login: 'pawpet-engine' }, created_at: '2026-11-22T09:59:00Z', body: '<!-- v2:spec-request assigned=claude-a history= -->' };
  const common = { owner: 'o', repo: 'r', issueNumber: 1, stage: 'To do', nonce: NONCE, sinceMs: SINCE, token: 't', deps: { config } };
  const sibling = await verify({ ...common, agentId: 'claude-a', deps: { config, listIssueComments: async () => [request, verdictBy('claude-b')], listCommentReactions: async () => [] } });
  assert.equal(sibling.ok, false, 'claude-b posting must not satisfy claude-a');
  const own = await verify({ ...common, agentId: 'claude-a', deps: { config, listIssueComments: async () => [request, verdictBy('claude-a')], listCommentReactions: async () => [] } });
  assert.equal(own.ok, true);
});
