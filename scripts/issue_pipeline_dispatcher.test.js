'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bodySha, normalizeBodyForHash } = require('./issue_pipeline_state');
const {
  resolvePipelineMode,
  computeEligibleAction,
  countWipInUse,
  applyLaneCaps,
  tick,
} = require('./issue_pipeline_dispatcher');

test('normalizeBodyForHash trims trailing whitespace per line', () => {
  const raw = 'Goal\n\n- [ ] P1  \n';
  assert.equal(normalizeBodyForHash(raw), 'Goal\n\n- [ ] P1');
});

test('bodySha is 16 hex chars', () => {
  const hash = bodySha('hello');
  assert.match(hash, /^[a-f0-9]{16}$/);
});

test('resolvePipelineMode defaults to off', () => {
  assert.equal(resolvePipelineMode(undefined), 'off');
  assert.equal(resolvePipelineMode('dry-run'), 'dry-run');
  assert.equal(resolvePipelineMode('ON'), 'on');
  assert.equal(resolvePipelineMode('bogus'), 'off');
});

test('manual-only issue gets no action', () => {
  const action = computeEligibleAction({
    number: 1,
    labels: ['manual-only'],
    status: 'To do',
    assignees: ['pawpet-claude'],
    liveBodySha: 'abc',
    state: {},
  });
  assert.equal(action, null);
});

test('To do + pawpet-claude schedules triage-intake', () => {
  const action = computeEligibleAction({
    labels: [],
    status: 'To do',
    assignees: ['pawpet-claude'],
    liveBodySha: 'deadbeef',
    state: {},
  });
  assert.equal(action.action, 'triage-intake');
  assert.equal(action.lane, 'triage');
});

test('Ready converged pawpet-bot without delivery label schedules delivery', () => {
  const action = computeEligibleAction({
    labels: [],
    status: 'Ready',
    assignees: ['pawpet-bot'],
    liveBodySha: 'abc',
    state: { body_sha: 'abc', converged_at: '2026-11-15T00:00:00Z' },
  });
  assert.equal(action.action, 'delivery');
  assert.equal(action.lane, 'delivery');
});

test('Ready queued issue schedules implement when unassigned', () => {
  const action = computeEligibleAction({
    labels: ['PR'],
    status: 'Ready',
    assignees: [],
    liveBodySha: 'abc',
    state: { body_sha: 'abc', converged_at: '2026-11-15T00:00:00Z' },
  });
  assert.equal(action.action, 'implement-launch');
});

test('In progress pawpet-bot schedules monitor', () => {
  const action = computeEligibleAction({
    labels: ['PR', 'busy'],
    status: 'In progress',
    assignees: ['pawpet-bot'],
    liveBodySha: 'abc',
    state: { body_sha: 'abc', converged_at: '2026-11-15T00:00:00Z' },
  });
  assert.equal(action.action, 'monitor');
});

test('countWipInUse counts in-progress busy pawpet-bot', () => {
  const n = countWipInUse([
    { status: 'In progress', assignees: ['pawpet-bot'], labels: ['busy'] },
    { status: 'In progress', assignees: ['pawpet-bot'], labels: [] },
    { status: 'Ready', assignees: [], labels: ['busy'] },
  ]);
  assert.equal(n, 2);
});

test('applyLaneCaps limits implement launches by WIP', () => {
  const planned = [
    { lane: 'implement', issue: 1, priority: 5 },
    { lane: 'implement', issue: 2, priority: 5 },
    { lane: 'implement', issue: 3, priority: 5 },
  ];
  const accepted = applyLaneCaps(planned, 2, 1);
  assert.equal(accepted.length, 1);
});

test('tick exits early when ISSUE_PIPELINE off', async () => {
  const result = await tick({
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    token: 't',
    mode: 'off',
  });
  assert.equal(result.skipped, true);
  assert.deepEqual(result.actions, []);
});

test('tick with issue_number uses direct Pawpet lookup', async () => {
  let listedFullProject = false;
  const result = await tick({
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    token: 't',
    issueNumber: 2337,
    mode: 'dry-run',
    io: {
      projectSecrets: {
        projectsPat: 'pat',
        projectId: 'PVT_proj',
        statusFieldId: 'SF_status',
      },
      assertPipelineStatusOptions: async () => [],
      loadIssueState: async () => ({ state: {} }),
      fetchPipelineIssueForProject: async () => ({
        number: 2337,
        title: 'Soak',
        body: 'body',
        labels: ['pipeline-beta'],
        status: 'To do',
        assignees: ['pawpet-claude'],
      }),
      listPipelineIssues: async () => {
        listedFullProject = true;
        return [];
      },
    },
  });
  assert.equal(listedFullProject, false);
  assert.equal(result.issueCount, 1);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].issue, 2337);
  assert.equal(result.actions[0].action, 'triage-intake');
});

test('tick on mode passes EXECUTE_PLAN_BOT_TOKEN to todo lane writes', async () => {
  const planBotToken = 'plan-bot-write-token';
  const readToken = 'actions-read-token';
  const priorPlanBot = process.env.EXECUTE_PLAN_BOT_TOKEN;
  process.env.EXECUTE_PLAN_BOT_TOKEN = planBotToken;
  let laneArgs;
  try {
    const result = await tick({
      owner: 'AgathaTrack',
      repo: 'AgathaTrack',
      token: readToken,
      issueNumber: 2337,
      mode: 'on',
      io: {
        projectSecrets: {
          projectsPat: 'pat',
          projectId: 'PVT_proj',
          statusFieldId: 'SF_status',
        },
        assertPipelineStatusOptions: async () => [],
        loadIssueState: async () => ({ state: {} }),
        fetchPipelineIssueForProject: async () => ({
          number: 2337,
          title: 'Soak',
          body: 'body',
          labels: [],
          status: 'To do',
          assignees: ['pawpet-claude'],
        }),
        listPipelineIssues: async () => [],
        runTodoLanePipeline: async (baseRun) => {
          laneArgs = baseRun;
          return { lane: 'todo', dryRun: false };
        },
      },
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.executed.length, 1);
    assert.ok(laneArgs);
    assert.equal(laneArgs.token, planBotToken);
    assert.equal(laneArgs.assignToken, planBotToken);
    assert.equal(laneArgs.dryRun, false);
  } finally {
    if (priorPlanBot === undefined) {
      delete process.env.EXECUTE_PLAN_BOT_TOKEN;
    } else {
      process.env.EXECUTE_PLAN_BOT_TOKEN = priorPlanBot;
    }
  }
});