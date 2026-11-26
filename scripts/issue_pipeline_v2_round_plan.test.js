'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { buildReviewRequest } = require('./issue_pipeline_v2_review');
const { planRounds } = require('./issue_pipeline_v2_round_plan');
const { commitOf } = require('./issue_pipeline_v2_secrets');

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

test('the logged plan and the live action name the same identity for the same board cursor', () => {
  const { decide } = require('./issue_pipeline_v2_decide');
  const order = config.agents.map((a) => a.id);
  // The board last assigned cursor-a: the next tier-a pick is claude-a, in both paths.
  const logged = planRounds({ comments: [], config, engineLogins: ENGINE, editors: {}, bodyHash: 'h0', issueNumber: 1, limits: config.limits, now: NOW, roundRobinAfter: 'cursor-a', roundRobinOrder: order });
  const live = decide({
    mode: 'on', now: NOW, onBoard: true, labels: ['pipeline-beta'], stage: 'In analysis', blocked: '', bodyHash: 'h0', wip: 0, totalVotes: 0,
    roundRobinAfter: 'cursor-a', roundRobinOrder: order,
    rounds: [{ tier: 'a', kind: 'spec', hashIn: null, attempts: [{ type: null, nonce: null, startedAt: null, result: 'spec', hashOut: 'h0' }] }],
  }, config);
  assert.equal(logged.plan.agent, live.agent);
  assert.equal(live.agent, 'claude-a');
});

// Real record formats (PIPE-V2-D-REV3-010, -011): a red with an edit posts its verdict on the NEW
// hash. The edit claim links that verdict back to the request it answered (request hash in, claimed
// hash out). Before the fix the verdict was looked up only on the request hash, so the attempt read
// as unfinished and the round's hashOut was lost.
const NONCE = 'c0ffee12';
const T_LAUNCH = NOW - 60 * 60 * 1000;
const at = (ms) => new Date(ms).toISOString();
const comment = (id, login, ms, body) => ({ id, user: { login }, created_at: at(ms), updated_at: at(ms), body });
const launchComment = (id, agent, ms, nonce) =>
  comment(id, ENGINE[0], ms, `<!-- v2:launch run=run-${id} agent=${agent} purpose=doorbell stage=In analysis commit=${commitOf(nonce)} -->\nStarted.`);
const claimComment = (id, login, ms, agent, hash, nonce) =>
  comment(id, login, ms, `<!-- v2:claim agent=${agent} kind=edit hash=${hash} commit=${commitOf(nonce)} -->\nEdited the body.`);
const verdictComment = (id, login, ms, agent, hash, value, nonce) =>
  comment(id, login, ms, `<!-- v2:verdict agent=${agent} nonce=${nonce} kind=review hash=${hash} value=${value} -->\n\`review\` \`${value}\`.`);

test('red with an edit, real formats: the edit closes the round; the verdict on the new hash is not counted', () => {
  const comments = [
    requestComment(1, 'h0', 'claude-a', T_LAUNCH),
    launchComment(2, 'claude-a', T_LAUNCH + 1000, NONCE),
    claimComment(3, 'pawpet-claude', T_LAUNCH + 2000, 'claude-a', 'h1', NONCE),
    verdictComment(4, 'pawpet-claude', T_LAUNCH + 3000, 'claude-a', 'h1', 'down', NONCE),
    requestComment(5, 'h1', 'cursor-a', T_LAUNCH + 4000),
  ];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h1', issueNumber: 1, limits: config.limits, now: NOW });
  const [spec, r2, r3] = out.derived;
  assert.equal(spec.kind, 'spec');
  assert.equal(r2.hashIn, 'h0');
  assert.deepEqual([r2.attempts[0].type, r2.attempts[0].result, r2.attempts[0].hashOut], ['claude-a', 'red', 'h1']);
  assert.equal(r3.hashIn, 'h1', 'the next request is the produced hash');
});

test('the same red verdict with no edit claim does not count: neither hash alone links it', () => {
  const comments = [
    requestComment(1, 'h0', 'claude-a', T_LAUNCH),
    launchComment(2, 'claude-a', T_LAUNCH + 1000, NONCE),
    verdictComment(4, 'pawpet-claude', T_LAUNCH + 3000, 'claude-a', 'h1', 'down', NONCE),
    requestComment(5, 'h1', 'cursor-a', T_LAUNCH + 4000),
  ];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h1', issueNumber: 1, limits: config.limits, now: NOW });
  const r2 = out.derived[1];
  assert.deepEqual([r2.attempts[0].result, r2.attempts[0].hashOut], [null, null]);
});

test('a late verdict from the old run, posted after the next request, does not attach to the previous request', () => {
  const comments = [
    requestComment(1, 'h0', 'claude-a', T_LAUNCH),
    launchComment(2, 'claude-a', T_LAUNCH + 1000, NONCE),
    claimComment(3, 'pawpet-claude', T_LAUNCH + 2000, 'claude-a', 'h1', NONCE),
    requestComment(4, 'h1', 'cursor-a', T_LAUNCH + 3000),
    verdictComment(5, 'pawpet-claude', T_LAUNCH + 4000, 'claude-a', 'h1', 'down', NONCE),
  ];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h1', issueNumber: 1, limits: config.limits, now: NOW });
  const r2 = out.derived[1];
  assert.deepEqual([r2.attempts[0].result, r2.attempts[0].hashOut], ['red', 'h1'], 'the edit closes the round');
  assert.equal(r2.attempts[0].nonce, null, 'the late verdict from the old run is not attached to this round');
});

// Review process v4 (PIPE-V2-D-REV4-001, -002): an edit closes its round and posts no verdict; the run
// that made the edit is the author of the new hash, whether or not it voted; a verdict on a hash the
// same run produced is a self-vote and is not counted.
test('an edit with no verdict still records its run as the author: the next tier-a pick is the other brand', () => {
  const comments = [
    requestComment(1, 'h0', 'claude-a', T_LAUNCH),
    launchComment(2, 'claude-a', T_LAUNCH + 1000, NONCE),
    claimComment(3, 'pawpet-claude', T_LAUNCH + 2000, 'claude-a', 'h1', NONCE),
  ];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h1', issueNumber: 1, limits: config.limits, now: NOW });
  assert.equal(out.derived[1].attempts[0].hashOut, 'h1', 'the edit produced h1');
  assert.equal(out.plan.type, 'request-round');
  assert.equal(out.plan.tier, 'a');
  assert.equal(out.plan.agent, 'cursor-a', 'the body was written by a claude run: the other brand comes first');
  assert.equal(out.plan.fallback, false);
});

// The #2103 sequence: R2, R3 and R4 each edit and post no verdict on their own edit, except claude-a on R4,
// whose up on its own edit is a self-vote. The challenge round (C1) must go to the other brand.
test('#2103 replay: edits close their rounds; the self-vote is not counted; C1 goes to the other brand', () => {
  const t = NOW - 2 * 60 * 60 * 1000;
  const n1 = 'c0ffee01';
  const n2 = 'c0ffee02';
  const n3 = 'c0ffee03';
  const comments = [
    requestComment(1, 'h0', 'claude-a', t),
    launchComment(2, 'claude-a', t + 1000, n1),
    claimComment(3, 'pawpet-claude', t + 2000, 'claude-a', 'h1', n1),
    requestComment(4, 'h1', 'cursor-a', t + 3000),
    launchComment(5, 'cursor-a', t + 4000, n2),
    claimComment(6, 'pawpet-bot', t + 5000, 'cursor-a', 'h2', n2),
    requestComment(7, 'h2', 'claude-a', t + 6000),
    launchComment(8, 'claude-a', t + 7000, n3),
    claimComment(9, 'pawpet-claude', t + 8000, 'claude-a', 'h3', n3),
    verdictComment(10, 'pawpet-claude', t + 9000, 'claude-a', 'h3', 'up', n3),
  ];
  const out = planRounds({ comments, config, engineLogins: ENGINE, editors: {}, bodyHash: 'h3', issueNumber: 1, limits: config.limits, now: NOW });
  const [, r2, r3, r4] = out.derived;
  assert.deepEqual(r2.attempts.map((a) => [a.type, a.result, a.hashOut]), [['claude-a', 'red', 'h1']]);
  assert.deepEqual(r3.attempts.map((a) => [a.type, a.result, a.hashOut]), [['cursor-a', 'red', 'h2']]);
  assert.deepEqual(r4.attempts.map((a) => [a.type, a.result, a.hashOut]), [['claude-a', 'red', 'h3']]);
  assert.deepEqual(out.ignored.map((v) => [v.agentId, v.hash, v.value, v.reason]), [['claude-a', 'h3', 'up', 'self-vote']]);
  assert.equal(out.plan.type, 'request-round');
  assert.equal(out.plan.tier, 'b');
  assert.equal(out.plan.round, 'C1');
  assert.equal(out.plan.agent, 'cursor-b', 'claude-a wrote h3: the other brand (cursor) is first');
  assert.equal(out.plan.fallback, false);
});
