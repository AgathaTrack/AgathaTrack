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
  listIssueComments,
  listCommentReactions,
} = require('./issue_pipeline_v2_comments');
const { decide } = require('./issue_pipeline_v2_decide');
const { tick } = require('./issue_pipeline_v2');

const config = { ...loadConfig(), engine: { logins: ['KanopeeKa'] } };
const NOW = Date.parse('2026-11-16T12:00:00Z');
const MIN = 60 * 1000;

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

test('blocked: a human comment with write access after the last agent comment wakes the agent', () => {
  const agent = { user: { login: 'pawpet-claude', type: 'User' }, author_association: 'MEMBER', created_at: '2026-11-16T10:00:00Z' };
  const owner = { user: { login: 'KanopeeKa', type: 'User' }, author_association: 'OWNER', created_at: '2026-11-16T11:00:00Z' };
  const stranger = { user: { login: 'someone', type: 'User' }, author_association: 'NONE', created_at: '2026-11-16T12:00:00Z' };
  const bot = { user: { login: 'github-actions[bot]', type: 'Bot' }, author_association: 'CONTRIBUTOR', created_at: '2026-11-16T13:00:00Z' };
  assert.equal(humanCommentSinceBlock([agent], config), false);
  assert.equal(humanCommentSinceBlock([agent, owner], config), true);
  assert.equal(humanCommentSinceBlock([agent, owner, stranger], config), false, 'a stranger does not wake it');
  assert.equal(humanCommentSinceBlock([owner, bot], config), false);
  assert.equal(humanCommentSinceBlock([], config), false);
});

test('readers use the real REST paths', async () => {
  const calls = [];
  const restFn = async (...args) => { calls.push(args); return []; };
  await listIssueComments({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', restFn });
  await listCommentReactions({ owner: 'o', repo: 'r', commentId: 77, token: 't', restFn });
  assert.deepEqual(calls.map((c) => [c[0], c[1]]), [
    ['GET', '/repos/o/r/issues/5/comments?per_page=100'],
    ['GET', '/repos/o/r/issues/comments/77/reactions?per_page=100'],
  ]);
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
        listProjectIssues: async () => [1, 2, 3].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack' } } })),
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
