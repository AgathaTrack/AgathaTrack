'use strict';

/**
 * Regression tests for the gaps the 2026-11-20 owner soak found (#2385 P8, soaks #2480–#2487).
 * Each test names the soak issue whose run exposed the gap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');
const { tick } = require('./issue_pipeline_v2');
const { memoComments, countEngineWip, lastUsedOnIssue } = require('./issue_pipeline_v2_tick_facts');
const { bodyHasRequestMarker, findRequestComment, reactionHint, runEvidence } = require('./pipeline_claude_run_lib');
const { verify } = require('./pipeline_claude_verify');

const config = loadConfig(); // cursor-a and cursor-b share pawpet-bot; claude-a is pawpet-claude
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-20T15:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function facts(over = {}) {
  return {
    mode: 'on',
    now: NOW,
    onBoard: true,
    labels: [],
    stage: 'To do',
    blocked: '',
    bodyHash: 'h1',
    totalVotes: 0,
    wip: 0,
    ...over,
  };
}

const signed = (agentId, v = 'up') => ({ login: config.agents.find((a) => a.id === agentId).actsAs, vote: v, hash: 'h1', agentId });

// --- soak-1 (#2480): a shared-login run approved the body it had edited -------------------------

test('#2480: an unclaimed edit by a shared login is a human edit; one signed approval does not converge', () => {
  const review = { requestedHash: 'h1', requestedAt: NOW, assignedTo: 'cursor-a', votes: [signed('cursor-a')] };
  const one = decide(facts({ stage: 'In analysis', lastBodyEditor: 'pawpet-bot', review }), config);
  assert.notEqual(one.type, 'set-stage', 'the approver may be the run that edited');
  const two = decide(
    facts({ stage: 'In analysis', lastBodyEditor: 'pawpet-bot', review: { ...review, votes: [signed('cursor-a'), signed('claude-a')] } }),
    config,
  );
  assert.deepEqual([two.type, two.to], ['set-stage', 'Ready'], 'two distinct ids converge');
});

test('#2480: with a verified edit claim the editor id is known; another id converges, the editor does not', () => {
  const base = { stage: 'In analysis', lastBodyEditor: 'pawpet-bot', editorAgentId: 'cursor-b' };
  const review = { requestedHash: 'h1', requestedAt: NOW, assignedTo: 'cursor-a' };
  const other = decide(facts({ ...base, review: { ...review, votes: [signed('cursor-a')] } }), config);
  assert.deepEqual([other.type, other.to], ['set-stage', 'Ready']);
  const self = decide(facts({ ...base, review: { ...review, votes: [signed('cursor-b')] } }), config);
  assert.notEqual(self.type, 'set-stage');
});

test('#2480: a login with one pool id keeps the single-approval rule', () => {
  const review = { requestedHash: 'h1', requestedAt: NOW, assignedTo: 'cursor-a', votes: [signed('cursor-a')] };
  const action = decide(facts({ stage: 'In analysis', lastBodyEditor: 'pawpet-claude', review }), config);
  assert.deepEqual([action.type, action.to], ['set-stage', 'Ready']);
});

// --- soak-6 (#2485): a silent doorbell held `busy` forever ---------------------------------------

test('#2485: busy holds a timed-out pickup for one extra timeout, then the pickup moves on', () => {
  const spec = (ago) => ({ requestedAt: NOW - ago * MIN, assignedTo: 'claude-a', timedOut: [] });
  assert.equal(decide(facts({ labels: ['busy'], spec: spec(31) }), config).reason, 'todo.waiting-busy');
  const moved = decide(facts({ labels: ['busy'], spec: spec(61) }), config);
  assert.equal(moved.type, 'reassign');
  assert.notEqual(moved.agent, 'claude-a');
});

// --- soak-3 (#2482): `paused` is the owner's hold ------------------------------------------------

test('#2482: a human comment does not wake a paused issue; other Blocked reasons still wake', () => {
  const woken = { humanCommentSinceBlock: true, humanCommentId: 9, spec: { assignedTo: 'cursor-a' } };
  assert.equal(decide(facts({ blocked: 'paused', ...woken }), config).reason, 'blocked.paused');
  assert.equal(decide(facts({ blocked: 'question', ...woken }), config).type, 'wake-stage-agent');
});

// --- soak-1 (#2480): hand-driven work filled the WIP queue ---------------------------------------

const launchRecord = (agent, at, issue = 1) => ({
  id: `${issue}-${agent}-${at}`,
  user: { login: 'pawpet-engine' },
  created_at: iso(at),
  body: `<!-- v2:launch run=r agent=${agent} purpose=doorbell stage=To do nonce=${'a'.repeat(32)} -->`,
});
const entry = (number, stage, over = {}) => ({ number, stage, labels: [], parsed: { stage }, ...over });

test('#2480: WIP counts only In progress issues the engine started', async () => {
  const comments = { 1: [launchRecord('cursor-a', NOW - 60 * MIN)], 2: [], 3: [launchRecord('cursor-b', NOW)] };
  const entries = [
    entry(1, 'In progress'),
    entry(2, 'In progress'), // hand-driven: no engine launch record
    entry(3, 'In progress', { labels: ['manual-only'] }),
    entry(4, 'Ready'),
  ];
  const wip = await countEngineWip({ entries, commentsOf: async (e) => comments[e.number] || [], engineLogins: ['pawpet-engine'] });
  assert.equal(wip, 1);
});

// --- soak-5 / soak-6 (#2484, #2485): rotation restarted at config order every tick ---------------

test('#2484: last-used is read from this issue\'s own launch records, newest per id', async () => {
  const comments = {
    1: [launchRecord('cursor-a', NOW - 10 * MIN), launchRecord('cursor-b', NOW - 5 * MIN), launchRecord('cursor-a', NOW - 2 * MIN)],
    3: [launchRecord('claude-a', NOW - 1 * MIN)],
  };
  const commentsOf = async (e) => comments[e.number] || [];
  const used = await lastUsedOnIssue({ entry: entry(1, 'In analysis'), commentsOf, config });
  assert.deepEqual(used, { 'cursor-a': NOW - 2 * MIN, 'cursor-b': NOW - 5 * MIN });
  const pick = decide(facts({ agentLastUsed: used }), config);
  assert.deepEqual([pick.type, pick.agent], ['request-spec', 'claude-a'], 'the id never started on this issue goes first');
  assert.deepEqual(await lastUsedOnIssue({ entry: entry(3, 'Backlog'), commentsOf, config }), {}, 'Backlog: comments are not read');
});

test('a failed comment read in the board pass does not stop the tick', async () => {
  const commentsOf = async (e) => {
    if (e.number === 2) throw new Error('rate limited');
    return [launchRecord('cursor-a', NOW - MIN, e.number)];
  };
  const entries = [entry(1, 'In progress'), entry(2, 'In progress')];
  assert.equal(await countEngineWip({ entries, commentsOf, engineLogins: ['pawpet-engine'] }), 1);
  assert.deepEqual(await lastUsedOnIssue({ entry: entries[1], commentsOf, config }), {});
});

test('comments are read once per issue per tick', async () => {
  let calls = 0;
  const memo = memoComments(async () => {
    calls += 1;
    return [];
  });
  await memo({ issueNumber: 1 });
  await memo({ issueNumber: 1 });
  await memo({ issueNumber: 2 });
  assert.equal(calls, 2);
});

// --- tick: dry-run reporting and the scoped rotation ---------------------------------------------

function tickIo({ issues, comments = {}, scopeLabel = 'pipeline-beta' }) {
  return {
    config,
    scopeLabel,
    fields: {
      stage: { id: 1, name: 'Stage', options: [] },
      blocked: { id: 2, name: 'Blocked', options: [] },
      attempts: { id: 3, name: 'Attempts', options: [] },
    },
    listProjectIssues: async () =>
      Object.keys(issues).map((n) => ({
        issue: { number: Number(n), state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } },
      })),
    getIssue: async (n) => issues[n],
    listIssueComments: async ({ issueNumber }) => comments[issueNumber] || [],
    listCommentReactions: async () => [],
  };
}

const todo = (number, labels = []) => ({
  number,
  body: `b${number}`,
  labels: labels.map((name) => ({ name })),
  issue_field_values: [{ field_id: 1, single_select_option: { name: 'To do' } }],
});

async function runTick(io) {
  const prior = process.env.ISSUE_PIPELINE_V2;
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(String(line));
  try {
    process.env.ISSUE_PIPELINE_V2 = 'dry-run';
    const result = await tick({ owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', io });
    return { result, events: logs.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)) };
  } finally {
    console.log = original;
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
}

test('#2428: a dry-run never logs `pipeline_v2_applied`; it logs what it would have done as planned', async () => {
  const { events } = await runTick(tickIo({ issues: { 1: todo(1, ['pipeline-beta']) } }));
  assert.equal(events.filter((e) => e.event === 'pipeline_v2_applied').length, 0);
  const planned = events.find((e) => e.event === 'pipeline_v2_planned');
  assert.ok(planned && planned.planned.includes('comment:spec-request'));
});

test('#2428: a dry-run that fails part-way logs planned, not applied', async () => {
  const io = tickIo({ issues: { 1: todo(1, ['pipeline-beta']) } });
  io.applyAction = async () => {
    const error = new Error('simulated write failed');
    error.applied = ['comment:spec-request'];
    throw error;
  };
  const { events, result } = await runTick(io);
  assert.equal(events.filter((e) => e.event === 'pipeline_v2_applied').length, 0);
  const planned = events.find((e) => e.event === 'pipeline_v2_planned' && e.partial);
  assert.deepEqual(planned && planned.planned, ['comment:spec-request']);
  assert.equal(result.errors.length, 1);
});

test('#2484: rotation is per issue: picks on other issues, in this tick or earlier, do not count', async () => {
  const ready = { field_id: 1, single_select_option: { name: 'Ready' } };
  const io = tickIo({
    issues: {
      1: todo(1, ['pipeline-beta']),
      2: todo(2, ['pipeline-beta']),
      3: { ...todo(3, ['pipeline-beta']), issue_field_values: [ready] },
    },
    comments: {
      1: [launchRecord('cursor-a', NOW - 10 * MIN, 1), launchRecord('cursor-b', NOW - 5 * MIN, 1)],
      3: [launchRecord('cursor-a', NOW - 10 * MIN, 3)],
    },
  });
  const { result } = await runTick(io);
  const agentOf = (n) => result.actions.find((a) => a.issue === n).action.agent;
  assert.equal(agentOf(1), 'claude-a', 'issue 1 already used cursor-a and cursor-b');
  assert.equal(agentOf(2), 'cursor-a', 'issue 2 has no history: config order, unaffected by issue 1 or 3');
});

// --- Claude runner (#2485) -----------------------------------------------------------------------

const engineComment = (id, body, at) => ({ id, user: { login: 'pawpet-engine' }, created_at: iso(at), body });

test('#2485: a request marker matches only as a whole token, including when the body contains backslashes', () => {
  assert.equal(bodyHasRequestMarker('<!-- v2:spec-request assigned=claude-a -->', 'v2:spec-request'), true);
  assert.equal(bodyHasRequestMarker('<!-- v2:spec-request -->', 'v2:spec-request'), true);
  assert.equal(bodyHasRequestMarker('<!--v2:spec-request-->', 'v2:spec-request'), false);
  assert.equal(bodyHasRequestMarker('<!-- v2:spec-request-extra -->', 'v2:spec-request'), false);
  assert.equal(bodyHasRequestMarker('note \\\\ <!-- v2:spec-request -->', 'v2:spec-request'), true);
  assert.equal(bodyHasRequestMarker('<!-- v2:review-request -->', 'v2:spec-request'), false);
});

test('#2485: the prepare step names the newest request comment for the stage and the exact vote command', () => {
  const comments = [
    engineComment(1, '<!-- v2:spec-request assigned=cursor-a history= -->', NOW - 60 * MIN),
    engineComment(2, '<!-- v2:spec-request assigned=claude-a history=cursor-a -->', NOW - MIN),
    { id: 3, user: { login: 'someone' }, created_at: iso(NOW), body: '<!-- v2:spec-request assigned=x history= -->' },
  ];
  assert.equal(findRequestComment({ comments, stage: 'To do', engineLogins: ['pawpet-engine'] }).id, 2);
  assert.equal(findRequestComment({ comments, stage: 'acceptance', engineLogins: ['pawpet-engine'] }), null);
  const hint = reactionHint({ owner: 'o', repo: 'r', stage: 'In analysis', commentId: 2 });
  assert.match(hint, /gh api -X POST repos\/o\/r\/issues\/comments\/2\/reactions -f content=\+1/);
  assert.match(hint, /content=-1/);
  assert.equal(reactionHint({ owner: 'o', repo: 'r', stage: 'To do', commentId: null }), '');
});

test('#2485: run evidence is a comment or a vote by the run login after it started; nothing else counts', () => {
  const since = NOW;
  const mine = { user: { login: 'pawpet-claude' } };
  assert.equal(runEvidence({ comments: [], reactions: [], actsAs: 'pawpet-claude', sinceMs: since }).ok, false);
  assert.equal(runEvidence({ comments: [{ ...mine, id: 1, created_at: iso(since - 10 * MIN) }], reactions: [], actsAs: 'pawpet-claude', sinceMs: since }).ok, false, 'an older comment');
  assert.equal(runEvidence({ comments: [{ id: 1, user: { login: 'pawpet-bot' }, created_at: iso(since + MIN) }], reactions: [], actsAs: 'pawpet-claude', sinceMs: since }).ok, false, 'another login');
  assert.equal(runEvidence({ comments: [{ ...mine, id: 1, created_at: iso(since + MIN) }], reactions: [], actsAs: 'pawpet-claude', sinceMs: since }).ok, true);
  assert.equal(runEvidence({ comments: [], reactions: [{ ...mine, content: '+1', created_at: iso(since + MIN) }], actsAs: 'pawpet-claude', sinceMs: since }).ok, true);
  assert.equal(runEvidence({ comments: [], reactions: [{ ...mine, content: 'eyes', created_at: iso(since + MIN) }], actsAs: 'pawpet-claude', sinceMs: since }).ok, false);
});

test('#2485: verify reads the issue as the run would and fails a silent run', async () => {
  const request = engineComment(7, '<!-- v2:spec-request assigned=claude-a history= -->', NOW - MIN);
  const args = { owner: 'o', repo: 'r', issueNumber: 2485, stage: 'To do', agentId: 'claude-a', sinceMs: NOW, token: 't' };
  const silent = await verify({ ...args, deps: { config, listIssueComments: async () => [request], listCommentReactions: async () => [] } });
  assert.equal(silent.ok, false);
  const voted = await verify({
    ...args,
    deps: {
      config,
      listIssueComments: async () => [request],
      listCommentReactions: async ({ commentId }) => (commentId === 7 ? [{ user: { login: 'pawpet-claude' }, content: '+1', created_at: iso(NOW + MIN) }] : []),
    },
  });
  assert.equal(voted.ok, true);
});
