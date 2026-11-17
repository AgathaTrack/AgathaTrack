'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig } = require('./issue_pipeline_v2_config');
const { checkDor, parseSections } = require('./issue_pipeline_v2_dor');
const {
  buildSpecRequest,
  parseSpecRequest,
  findSpecRequest,
  deriveSpecFacts,
  humanCommentSinceBlock,
  fetchAllPages,
  listIssueComments,
  listCommentReactions,
} = require('./issue_pipeline_v2_comments');
const { decide } = require('./issue_pipeline_v2_decide');
const { tick } = require('./issue_pipeline_v2');

const config = { ...loadConfig(), engine: { logins: ['KanopeeKa'] } };
const NOW = Date.parse('2026-11-16T12:00:00Z');

const TASK = `### Summary

Replace the engine.

### Objective

Done end to end.

### Definition of Done

- [ ] tests pass

### Affected Area

scripts
`;

test('DoR: a complete task passes; each missing piece is named', () => {
  assert.deepEqual(checkDor(TASK, ['task']), { ok: true, template: 'task', missing: [] });
  const bad = checkDor(
    '### Summary\n\n_No response_\n\n### Definition of Done\n\njust words\n\n### Affected Area\n\nci',
    ['task'],
  );
  assert.deepEqual(bad.missing, [
    { section: 'Summary', reason: 'empty' },
    { section: 'Objective', reason: 'absent' },
    { section: 'Definition of Done', reason: 'no-checkbox' },
  ]);
  assert.equal(bad.ok, false);
});

test('DoR: feature and bug follow their own template; unknown shape is not ready', () => {
  const feature = checkDor(
    '### Summary\nx\n### Problem to Solve\ny\n### Acceptance Criteria\n- [ ] a\n### Affected Area\nz',
    ['feature'],
  );
  assert.equal(feature.ok, true);
  const bug = checkDor('### Current Behavior\nx\n### Expected Behavior\ny\n### Affected Area\nz', ['bug']);
  assert.equal(bug.ok, true);
  assert.equal(checkDor('hello', []).missing[0].reason, 'unknown-template');
  // template is inferred from the sections when no label says which
  assert.equal(checkDor(TASK, []).template, 'task');
});

test('DoR: headings inside code fences are not sections; checkbox text must be non-empty', () => {
  const sections = parseSections('### Summary\nreal\n```\n### Objective\nfake\n```\n');
  assert.deepEqual([...sections.keys()], ['summary']);
  assert.equal(checkDor(TASK.replace('- [ ] tests pass', '- [ ]'), ['task']).missing[0].reason, 'no-checkbox');
});

test('DoR: a real light-plan style issue body passes (the shape of #2385)', () => {
  const body = TASK + '\n### Delivery plan\n\nMethod: light-plan\n';
  assert.equal(checkDor(body, ['task']).ok, true);
});

test('spec request: the marker round-trips assignee and history', () => {
  const body = buildSpecRequest({ assigned: 'pawpet-claude', history: ['pawpet-bot'] });
  assert.deepEqual(parseSpecRequest(body), { assigned: 'pawpet-claude', history: ['pawpet-bot'] });
  assert.deepEqual(parseSpecRequest(buildSpecRequest({ assigned: 'a' })), { assigned: 'a', history: [] });
  assert.equal(parseSpecRequest('no marker here'), null);
});

const requestComment = (over = {}) => ({
  id: 10,
  user: { login: 'KanopeeKa' },
  body: buildSpecRequest({ assigned: 'pawpet-bot' }),
  created_at: '2026-11-16T11:30:00Z',
  updated_at: '2026-11-16T11:30:00Z',
  ...over,
});

test('spec facts: only an engine-authored request counts; a forged one is ignored', () => {
  const forged = requestComment({ id: 11, user: { login: 'pawpet-bot' }, created_at: '2026-11-16T11:59:00Z' });
  const found = findSpecRequest([forged, requestComment()], config.engine.logins);
  assert.equal(found.comment.id, 10);
  assert.equal(findSpecRequest([forged], config.engine.logins), null);
  assert.equal(findSpecRequest([requestComment()], []), null, 'no engine identity configured trusts nothing');
});

test('spec facts: a 👍 from a listed agent after the request is the DoR pass', () => {
  const reaction = (login, content, at) => ({ user: { login }, content, created_at: at });
  const facts = (reactions) =>
    deriveSpecFacts({ comments: [requestComment()], reactions, config, engineLogins: config.engine.logins });
  assert.equal(facts([reaction('pawpet-bot', '+1', '2026-11-16T11:40:00Z')]).passedBy, 'pawpet-bot');
  assert.equal(facts([reaction('KanopeeKa', '+1', '2026-11-16T11:40:00Z')]).passedBy, null, 'the owner is not an agent');
  assert.equal(facts([reaction('pawpet-bot', '-1', '2026-11-16T11:40:00Z')]).passedBy, null);
  assert.equal(facts([reaction('pawpet-bot', '+1', '2026-11-16T11:00:00Z')]).passedBy, null, 'older than the request');
  assert.deepEqual(deriveSpecFacts({ comments: [], reactions: [], config, engineLogins: ['KanopeeKa'] }), {});
});

test('spec facts feed decide(): request, wait, reassign, stall and pass', () => {
  const base = { mode: 'dry-run', now: NOW, onBoard: true, stage: 'To do', labels: [] };
  const spec = (comments, reactions = []) =>
    deriveSpecFacts({ comments, reactions, config, engineLogins: config.engine.logins });
  assert.equal(decide({ ...base, spec: spec([]) }, config).type, 'request-spec');
  const fresh = requestComment({ created_at: '2026-11-16T11:50:00Z', updated_at: '2026-11-16T11:50:00Z' });
  assert.equal(decide({ ...base, spec: spec([fresh]) }, config).reason, 'todo.waiting');
  // exactly the 30 minute timeout counts as timed out
  assert.equal(decide({ ...base, spec: spec([requestComment()]) }, config).type, 'reassign');
  const late = requestComment({ updated_at: '2026-11-16T11:00:00Z', created_at: '2026-11-16T11:00:00Z' });
  const reassign = decide({ ...base, spec: spec([late]) }, config);
  assert.deepEqual([reassign.type, reassign.agent], ['reassign', 'pawpet-claude']);
  const both = requestComment({
    body: buildSpecRequest({ assigned: 'pawpet-claude', history: ['pawpet-bot'] }),
    updated_at: '2026-11-16T11:00:00Z',
    created_at: '2026-11-16T11:00:00Z',
  });
  assert.equal(decide({ ...base, spec: spec([both]) }, config).reason, 'stalled');
  const passed = spec([requestComment()], [{ user: { login: 'pawpet-bot' }, content: '+1', created_at: '2026-11-16T11:45:00Z' }]);
  assert.equal(decide({ ...base, spec: passed }, config).to, 'In analysis');
});

test('blocked: any write-access human comment after the last agent or engine comment wakes the agent', () => {
  const at = (hour) => `2026-11-16T${hour}:00:00Z`;
  const agent = { user: { login: 'pawpet-claude', type: 'User' }, author_association: 'MEMBER', created_at: at('10') };
  const human = { user: { login: 'maintainer', type: 'User' }, author_association: 'OWNER', created_at: at('11') };
  const stranger = { user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: at('12') };
  const bot = { user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'CONTRIBUTOR', created_at: at('13') };
  const engine = { user: { login: 'KanopeeKa', type: 'User' }, author_association: 'OWNER', created_at: at('14') };
  const agentAgain = { ...agent, created_at: at('15') };
  assert.equal(humanCommentSinceBlock([agent], config), false);
  assert.equal(humanCommentSinceBlock([agent, human], config), true);
  assert.equal(humanCommentSinceBlock([agent, human, stranger, bot], config), true, 'not only the newest comment counts');
  assert.equal(humanCommentSinceBlock([agent, stranger, bot], config), false, 'strangers and bots do not wake it');
  assert.equal(humanCommentSinceBlock([agent, human, agentAgain], config), false, 'the agent already answered');
  assert.equal(humanCommentSinceBlock([agent, human, engine], config), false, 'the engine identity is not a human, and anchors');
  assert.equal(humanCommentSinceBlock([human], config), true, 'no agent comment yet');
  assert.equal(humanCommentSinceBlock([], config), false);
});

test('readers use the real REST paths', async () => {
  const calls = [];
  const restFn = async (...args) => { calls.push(args); return []; };
  await listIssueComments({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', restFn });
  await listCommentReactions({ owner: 'o', repo: 'r', commentId: 77, token: 't', restFn });
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [
    ['GET', '/repos/o/r/issues/5/comments?per_page=100&page=1'],
    ['GET', '/repos/o/r/issues/comments/77/reactions?per_page=100&page=1'],
  ]);
});

test('readers page past 100 items so the newest request and the latest vote are not missed', async () => {
  const item = (n) => ({ id: n });
  const pages = { 1: Array.from({ length: 100 }, (_, i) => item(i)), 2: Array.from({ length: 100 }, (_, i) => item(100 + i)), 3: [item(200)] };
  const paths = [];
  const restFn = async (_method, path) => { paths.push(path); return pages[Number(/&page=(\d+)/.exec(path)[1])]; };
  const all = await listIssueComments({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', restFn });
  assert.equal(all.length, 201);
  assert.equal(all[200].id, 200, 'the item on the last page is returned');
  assert.equal(paths.length, 3);
  // an exactly full last page triggers one more (empty) request, then stops
  const exact = [];
  await fetchAllPages({ path: '/x', token: 't', perPage: 2, restFn: async (_m, path) => { exact.push(path); return path.endsWith('page=1') ? [1, 2] : []; } });
  assert.equal(exact.length, 2);
  // a runaway is bounded
  let calls = 0;
  await fetchAllPages({ path: '/x', token: 't', perPage: 1, maxPages: 4, restFn: async () => { calls += 1; return [1]; } });
  assert.equal(calls, 4);
});

test('config: the engine identity may be empty but never a listed agent', () => {
  assert.doesNotThrow(() => validateConfig({ ...config, engine: { logins: [] } }));
  assert.throws(() => validateConfig({ ...config, engine: { logins: ['pawpet-bot'] } }), /must not be a listed agent/);
  assert.throws(() => validateConfig({ ...config, engine: undefined }), /engine\.logins/);
});

test('runner: a To do issue reads its comments and reactions; Backlog and Done cost no calls', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  const calls = [];
  const issue = (n, stage) => ({
    number: n, body: 'b', labels: [], issue_field_values: [{ field_id: 1, single_select_option: { name: stage } }],
  });
  const issues = { 1: issue(1, 'To do'), 2: issue(2, 'Backlog'), 3: issue(3, 'Done') };
  try {
    const result = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config,
        fields: {
          stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] },
          attempts: { id: 3, name: 'Attempts', options: [] }, totalN: { id: 4, name: 'Total N', options: [] },
        },
        listProjectIssues: async () => [1, 2, 3].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } })),
        getIssue: async (n) => issues[n],
        listIssueComments: async ({ issueNumber }) => { calls.push(['comments', issueNumber]); return [requestComment()]; },
        listCommentReactions: async ({ commentId }) => {
          calls.push(['reactions', commentId]);
          return [{ user: { login: 'pawpet-claude' }, content: '+1', created_at: '2026-11-16T11:40:00Z' }];
        },
      },
    });
    assert.deepEqual(calls, [['comments', 1], ['reactions', 10]]);
    const todo = result.actions.find((entry) => entry.issue === 1).action;
    assert.deepEqual([todo.type, todo.to], ['set-stage', 'In analysis']);
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});
