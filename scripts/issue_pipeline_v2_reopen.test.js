'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('./issue_pipeline_v2_decide');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { buildReopened, reopenedByEngine } = require('./issue_pipeline_v2_release');
const { tick } = require('./issue_pipeline_v2');

const config = loadConfig();
const base = { mode: 'on', onBoard: true, now: 1e12, closed: true, closeReason: 'completed' };

test('a closed issue still in delivery is reopened, once', () => {
  for (const stage of ['In progress', 'In Main', 'In UAT']) {
    const action = decide({ ...base, stage }, config);
    assert.deepEqual([action.type, action.stage, action.row], ['reopen', stage, 'closed.reopen']);
  }
  assert.equal(decide({ ...base, stage: 'In Main', reopenedBefore: true }, config).reason, 'closed', 'a second close is deliberate');
});

test('closing is left alone when it can be deliberate or is final', () => {
  assert.equal(decide({ ...base, stage: 'In Main', closeReason: 'not_planned' }, config).reason, 'closed');
  assert.equal(decide({ ...base, stage: 'Done' }, config).reason, 'closed');
  for (const stage of ['Backlog', 'To do', 'In analysis', 'Ready']) {
    assert.equal(decide({ ...base, stage }, config).reason, 'closed', stage);
  }
  assert.equal(decide({ ...base, stage: 'In Main', labels: ['manual-only'] }, config).reason, 'manual-only');
});

test('reopen: PATCH state open, then the marker comment (so it happens once)', async () => {
  const sent = [];
  const result = await applyAction({
    action: { type: 'reopen', stage: 'In Main' },
    ctx: {
      owner: 'o', repo: 'r', issueNumber: 2335, token: 'p', config, fields: {}, parsed: {}, assignees: [], counters: {}, facts: {}, dryRun: false,
      restFn: async (method, path, token, body) => { sent.push({ method, path, body }); return {}; },
    },
  });
  assert.deepEqual(sent[0], { method: 'PATCH', path: '/repos/o/r/issues/2335', body: { state: 'open' } });
  assert.match(sent[1].body.body, /v2:reopened/);
  assert.match(sent[1].body.body, /In Main/);
  assert.deepEqual(result.applied, ['reopen', 'comment:reopened']);
});

test('the reopened marker counts only from an engine login', () => {
  const body = buildReopened({ stage: 'In UAT' });
  assert.equal(reopenedByEngine([{ user: { login: 'pawpet-engine' }, body }], ['pawpet-engine']), true);
  assert.equal(reopenedByEngine([{ user: { login: 'someone' }, body }], ['pawpet-engine']), false);
  assert.equal(reopenedByEngine([], ['pawpet-engine']), false);
});

const fields = {
  stage: { id: 1, name: 'Stage', options: [] },
  blocked: { id: 2, name: 'Blocked', options: [] },
  attempts: { id: 3, name: 'Attempts', options: [] },
  totalN: { id: 4, name: 'Total N', options: [] },
};
const ref = (number, state, extra = {}) => ({ number, state, repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } }, ...extra });
const stage = (name) => [{ field_id: 1, single_select_option: { name } }];

async function run(io, env = 'dry-run') {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = env;
  const orig = console.error;
  console.error = () => {};
  try {
    return await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: { config: { ...config, engine: { logins: ['pawpet-engine'] } }, fields, scopeLabel: '', ...io },
    });
  } finally {
    console.error = orig;
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
}

test('runner: only closed issues on a delivery column, closed as completed, in a delivery stage, are reopened', async () => {
  const issues = {
    1: { number: 1, state: 'closed', state_reason: 'completed', body: '', labels: [], issue_field_values: stage('In Main') },
    2: { number: 2, state: 'closed', state_reason: 'not_planned', body: '', labels: [], issue_field_values: stage('In Main') },
    3: { number: 3, state: 'closed', state_reason: 'completed', body: '', labels: [{ name: 'manual-only' }], issue_field_values: stage('In Main') },
    4: { number: 4, state: 'closed', state_reason: 'completed', body: '', labels: [], issue_field_values: stage('Backlog') },
    5: { number: 5, state: 'closed', state_reason: 'completed', body: '', labels: [], issue_field_values: stage('In UAT') },
    6: { number: 6, state: 'closed', state_reason: 'completed', body: '', labels: [], issue_field_values: stage('Done') },
  };
  const fetched = [];
  const applied = [];
  const result = await run({
    listProjectIssues: async () => [
      { status: 'In Main', issue: ref(1, 'CLOSED') },
      { status: 'In Main', issue: ref(2, 'CLOSED') },
      { status: 'In Main', issue: ref(3, 'CLOSED') },
      { status: 'In Progress', issue: ref(4, 'CLOSED') },
      { status: 'In UAT', issue: ref(5, 'CLOSED') },
      { status: 'Done', issue: ref(6, 'CLOSED') },
      { status: 'Done', issue: ref(7, 'CLOSED') },
    ],
    getIssue: async (n) => { fetched.push(n); return issues[n]; },
    listIssueComments: async (args) => (args.issueNumber === 5 ? [{ user: { login: 'pawpet-engine' }, body: buildReopened({ stage: 'In UAT' }), created_at: '2026-11-17T00:00:00Z' }] : []),
    applyAction: async ({ action, ctx }) => { applied.push([ctx.issueNumber, action.type]); return { applied: [], calls: [] }; },
  });
  assert.deepEqual(fetched.sort(), [1, 2, 3, 4, 5], 'Done rows are never fetched');
  const byIssue = Object.fromEntries(result.actions.map((entry) => [entry.issue, entry.action.type]));
  // 2 (not planned), 3 (manual-only) and 4 (Backlog) are dropped before decide(); 5 was already reopened once
  assert.deepEqual(byIssue, { 1: 'reopen', 5: 'none' });
  assert.equal(result.wip, 0, 'closed issues take no WIP slot');
});

test('runner: `on` without a valid engine identity ends red instead of stalling quietly', async () => {
  const result = await run(
    {
      checkEngineIdentity: async () => ({ ok: false, reason: 'token-not-engine-identity' }),
      listProjectIssues: async () => [],
      getIssue: async () => undefined,
    },
    'on',
  );
  assert.deepEqual(result.errors, [{ issue: null, message: 'engine identity: token-not-engine-identity' }]);
  const okResult = await run(
    { checkEngineIdentity: async () => ({ ok: true }), listProjectIssues: async () => [], getIssue: async () => undefined },
    'on',
  );
  assert.deepEqual(okResult.errors, []);
});
