'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, validateConfig } = require('./issue_pipeline_v2_config');
const { decide, canonicalStage } = require('./issue_pipeline_v2_decide');
const {
  loadOrgFields,
  parseIssueFields,
  buildFieldWrites,
  writeIssueFields,
} = require('./issue_pipeline_v2_fields');
const { tick, buildWrites, WRITES_ENABLED } = require('./issue_pipeline_v2');

const config = loadConfig();
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-16T12:00:00Z');

function facts(over = {}) {
  return {
    mode: 'dry-run',
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

const rowOf = (over) => decide(facts(over), config);

test('config: the committed file is valid; bad edits are reported together', () => {
  assert.equal(config.agents.length, 2);
  assert.throws(
    () => validateConfig({ agents: [{ login: 'a', methods: ['nope'] }], limits: {} }),
    /at least two listed agents[\s\S]*unknown method nope[\s\S]*limits\.wip/,
  );
});

test('stage names are matched case-insensitively and empty reads as Backlog', () => {
  assert.equal(canonicalStage('In Analysis'), 'In analysis');
  assert.equal(canonicalStage('in analysis'), 'In analysis');
  assert.equal(canonicalStage(''), 'Backlog');
  assert.equal(canonicalStage(undefined), 'Backlog');
  assert.equal(canonicalStage('Triage'), null);
});

test('guards: mode, board, manual-only, unknown stage', () => {
  assert.equal(rowOf({ mode: 'off' }).reason, 'mode-off');
  assert.equal(rowOf({ mode: undefined }).reason, 'mode-off');
  assert.equal(rowOf({ onBoard: false }).reason, 'not-on-board');
  assert.equal(rowOf({ labels: ['manual-only'] }).reason, 'manual-only');
  assert.equal(rowOf({ stage: 'Triage' }).reason, 'unknown-stage');
});

test('guards: a Blocked issue only wakes on a human comment and is never cleared', () => {
  assert.equal(rowOf({ blocked: 'question' }).reason, 'blocked');
  assert.deepEqual(
    rowOf({ blocked: 'question', humanCommentSinceBlock: true }),
    { type: 'wake-stage-agent', stage: 'To do', row: 'blocked.wake' },
  );
});

test('empty Stage reads as Backlog; follow-ups get To do within depth 2, Backlog beyond', () => {
  assert.equal(rowOf({ stage: '' }).reason, 'stage-backlog');
  assert.equal(rowOf({ stage: '', followUp: { depth: 1 } }).to, 'To do');
  assert.equal(rowOf({ stage: '', followUp: { depth: 2 } }).to, 'To do');
  assert.equal(rowOf({ stage: '', followUp: { depth: 3 } }).to, 'Backlog');
  // a follow-up that already has a Stage is left alone
  assert.equal(rowOf({ stage: 'To do', followUp: { depth: 1 } }).type, 'request-spec');
});

test('any stage: an escalation sets Blocked=decision', () => {
  for (const stage of ['To do', 'In analysis', 'Ready', 'In progress', 'In Main']) {
    assert.deepEqual(rowOf({ stage, escalation: true }), {
      type: 'set-blocked',
      reason: 'decision',
      row: 'any.escalation',
    });
  }
});

test('To do: request, wait, reassign, stall, pass', () => {
  assert.equal(rowOf({}).type, 'request-spec');
  const base = { spec: { requestedAt: NOW - 5 * MIN, assignedTo: 'pawpet-bot' } };
  assert.equal(rowOf(base).reason, 'todo.waiting');
  const late = { spec: { requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-bot', timedOut: [] } };
  assert.deepEqual(
    [rowOf(late).type, rowOf(late).agent],
    ['reassign', 'pawpet-claude'],
  );
  const allLate = {
    spec: { requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-claude', timedOut: ['pawpet-bot'] },
  };
  assert.equal(rowOf(allLate).reason, 'stalled');
  assert.equal(rowOf({ spec: { passedBy: 'pawpet-bot' } }).to, 'In analysis');
});

test('To do: the least recently used agent is picked', () => {
  const action = rowOf({ agentLastUsed: { 'pawpet-bot': NOW - MIN, 'pawpet-claude': NOW - 99 * MIN } });
  assert.equal(action.agent, 'pawpet-claude');
});

const vote = (login, v, hash = 'h1') => ({ login, vote: v, hash });

test('In analysis: spec draft by an agent plus one other agent converges', () => {
  const action = rowOf({
    stage: 'In analysis',
    lastBodyEditor: 'pawpet-claude',
    review: { requestedHash: 'h1', requestedAt: NOW, assignedTo: 'pawpet-bot', votes: [vote('pawpet-bot', 'up')] },
  });
  assert.equal(action.to, 'Ready');
});

test('In analysis: after a human edit two agents are needed; the editor cannot approve itself', () => {
  const one = rowOf({
    stage: 'In analysis',
    lastBodyEditor: 'KanopeeKa',
    review: { requestedHash: 'h1', requestedAt: NOW, assignedTo: 'pawpet-claude', votes: [vote('pawpet-bot', 'up')] },
  });
  assert.equal(one.type, 'none');
  const two = rowOf({
    stage: 'In analysis',
    lastBodyEditor: 'KanopeeKa',
    review: {
      requestedHash: 'h1',
      requestedAt: NOW,
      votes: [vote('pawpet-bot', 'up'), vote('pawpet-claude', 'up')],
    },
  });
  assert.equal(two.to, 'Ready');
  const self = rowOf({
    stage: 'In analysis',
    lastBodyEditor: 'pawpet-bot',
    review: { requestedHash: 'h1', requestedAt: NOW, assignedTo: 'pawpet-claude', votes: [vote('pawpet-bot', 'up')] },
  });
  assert.equal(self.type, 'none');
});

test('In analysis: votes on an older hash and thumbs-down do not approve', () => {
  const action = rowOf({
    stage: 'In analysis',
    lastBodyEditor: 'pawpet-claude',
    review: {
      requestedHash: 'h1',
      requestedAt: NOW,
      assignedTo: 'pawpet-bot',
      votes: [vote('pawpet-bot', 'up', 'h0'), vote('pawpet-bot', 'down', 'h1')],
    },
  });
  assert.equal(action.type, 'none');
});

test('In analysis: convergence wins over the vote cap; the cap blocks otherwise', () => {
  const converging = rowOf({
    stage: 'In analysis',
    totalVotes: 6,
    lastBodyEditor: 'pawpet-claude',
    review: { requestedHash: 'h1', requestedAt: NOW, votes: [vote('pawpet-bot', 'up')] },
  });
  assert.equal(converging.to, 'Ready');
  const stuck = rowOf({
    stage: 'In analysis',
    totalVotes: 6,
    lastBodyEditor: 'pawpet-claude',
    review: { requestedHash: 'h1', requestedAt: NOW, votes: [vote('pawpet-bot', 'down')] },
  });
  assert.deepEqual([stuck.type, stuck.reason], ['set-blocked', 'no-convergence']);
  assert.equal(rowOf({ stage: 'In analysis', totalVotes: 5, lastBodyEditor: 'pawpet-claude' }).type, 'request-review');
});

test('In analysis: a new hash gets a new request, excluding the last editor', () => {
  const action = rowOf({
    stage: 'In analysis',
    bodyHash: 'h2',
    lastBodyEditor: 'pawpet-claude',
    review: { requestedHash: 'h1', requestedAt: NOW - 60 * MIN, assignedTo: 'pawpet-bot' },
  });
  assert.deepEqual([action.type, action.hash, action.agent], ['request-review', 'h2', 'pawpet-bot']);
});

test('In analysis: nobody else eligible after a thumbs-down, the editor revises', () => {
  const action = rowOf({
    stage: 'In analysis',
    lastBodyEditor: 'pawpet-claude',
    review: { requestedHash: 'h1', requestedAt: NOW, votes: [vote('pawpet-bot', 'down')] },
  });
  assert.deepEqual([action.type, action.agent], ['reassign', 'pawpet-claude']);
});

test('In analysis: timeout reassigns, then stalls once every eligible agent timed out', () => {
  const late = rowOf({
    stage: 'In analysis',
    lastBodyEditor: null,
    review: { requestedHash: 'h1', requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-bot' },
  });
  assert.deepEqual([late.type, late.agent], ['reassign', 'pawpet-claude']);
  const stalled = rowOf({
    stage: 'In analysis',
    lastBodyEditor: null,
    review: { requestedHash: 'h1', requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-claude', timedOut: ['pawpet-bot'] },
  });
  assert.deepEqual([stalled.type, stalled.reason], ['set-blocked', 'stalled']);
});

test('Ready: queue, launch, ack window, backoff, blocked', () => {
  const ready = { stage: 'Ready', deliveryMethod: 'PR' };
  assert.equal(rowOf({ ...ready, wip: 2 }).reason, 'ready.queued');
  assert.equal(rowOf({ ...ready }).type, 'launch');
  assert.equal(rowOf({ ...ready, deliveryMethod: 'execute-plan' }).agent, 'pawpet-bot');
  assert.equal(
    rowOf({ ...ready, deliveryMethod: 'execute-plan', agentLastUsed: { 'pawpet-bot': NOW } }).agent,
    'pawpet-bot',
  );
  assert.equal(rowOf({ ...ready, launch: { runId: 'r1', startedAt: NOW - 5 * MIN } }).reason, 'ready.waiting-ack');
  assert.equal(rowOf({ ...ready, launch: { runId: 'r1', startedAt: NOW - 5 * MIN, busy: true } }).to, 'In progress');
  // ack window passed without busy: one failed start, 5 min backoff counted from the window end
  const lateRun = { runId: 'r1', startedAt: NOW - 17 * MIN };
  assert.equal(rowOf({ ...ready, launch: lateRun }).reason, 'ready.backoff');
  assert.equal(rowOf({ ...ready, launch: { runId: 'r1', startedAt: NOW - 30 * MIN } }).type, 'launch');
  // explicit failures: 5, 30, 120 min, then blocked
  const failed = (n, ago) => rowOf({ ...ready, launch: { failures: n, lastFailureAt: NOW - ago * MIN } });
  assert.equal(failed(1, 4).reason, 'ready.backoff');
  assert.equal(failed(1, 6).type, 'launch');
  assert.equal(failed(2, 29).reason, 'ready.backoff');
  assert.equal(failed(3, 119).reason, 'ready.backoff');
  assert.equal(failed(3, 121).type, 'launch');
  assert.deepEqual([failed(4, 500).type, failed(4, 500).reason], ['set-blocked', 'launch-failed']);
});

test('Ready: a method no agent can run blocks instead of launching', () => {
  const action = rowOf({ stage: 'Ready', deliveryMethod: 'unknown' });
  assert.deepEqual([action.type, action.reason], ['set-blocked', 'launch-failed']);
});

test('In progress: working, resume once, stalled, finished', () => {
  const stage = 'In progress';
  const busy = { busy: true, lastActivityAt: NOW - MIN };
  assert.equal(rowOf({ stage, delivery: busy }).reason, 'progress.working');
  assert.equal(rowOf({ stage, delivery: { busy: false } }).type, 'resume');
  assert.equal(rowOf({ stage, delivery: { busy: false, resumed: true } }).reason, 'stalled');
  assert.equal(rowOf({ stage, delivery: { busy: true, lastActivityAt: NOW - 25 * 60 * MIN } }).type, 'resume');
  const done = { busy: false, dodComplete: true, openLinkedPrs: 0, mergedIntoMain: 1 };
  const finished = rowOf({ stage, delivery: done });
  assert.deepEqual([finished.to, finished.then], ['In Main', ['request-intent-review']]);
  // each condition is needed
  for (const missing of [{ dodComplete: false }, { openLinkedPrs: 1 }, { mergedIntoMain: 0 }, { busy: true }]) {
    assert.notEqual(rowOf({ stage, delivery: { ...done, ...missing, lastActivityAt: NOW } }).to, 'In Main');
  }
});

test('In Main: intent review first, from an agent that did not author the PRs, then UAT', () => {
  const request = rowOf({ stage: 'In Main', prAuthors: ['pawpet-bot'] });
  assert.deepEqual([request.type, request.agent], ['request-intent-review', 'pawpet-claude']);
  const everyone = rowOf({ stage: 'In Main', prAuthors: ['pawpet-bot', 'pawpet-claude'] });
  assert.equal(everyone.type, 'request-intent-review');
  const requested = { stage: 'In Main', intentReview: { requested: true } };
  assert.equal(rowOf(requested).reason, 'main.waiting-uat');
  assert.equal(rowOf({ ...requested, uatContainsLatestMerge: true }).to, 'In UAT');
});

test('In UAT: Done and close only when prod contains the latest merge', () => {
  assert.equal(rowOf({ stage: 'In UAT' }).reason, 'uat.waiting-prod');
  const done = rowOf({ stage: 'In UAT', prodContainsLatestMerge: true });
  assert.deepEqual([done.to, done.close], ['Done', true]);
  assert.equal(rowOf({ stage: 'Done' }).type, 'none');
});

test('every non-none action names the table row it implements', () => {
  const stages = ['To do', 'In analysis', 'Ready', 'In progress', 'In Main', 'In UAT'];
  for (const stage of stages) {
    const action = rowOf({ stage, deliveryMethod: 'PR' });
    assert.ok(action.type === 'none' || action.row, `${stage}: ${JSON.stringify(action)} names its table row`);
  }
});

function orgFieldDefs() {
  return [
    { id: 1, name: 'Stage', options: ['Backlog', 'To do', 'In analysis', 'Ready', 'In progress', 'In Main', 'In UAT', 'Done'].map((name) => ({ name })) },
    { id: 2, name: 'Blocked', options: ['question', 'no-convergence', 'launch-failed', 'decision', 'stalled', 'paused'].map((name) => ({ name })) },
    { id: 3, name: 'Attempts' },
    { id: 4, name: 'Total N' },
  ];
}

test('fields: org definitions are loaded with the real request path; a missing field throws', async () => {
  const seen = [];
  const fields = await loadOrgFields({
    org: 'AgathaTrack',
    token: 't',
    restFn: async (method, path, token) => {
      seen.push([method, path, token]);
      return orgFieldDefs();
    },
  });
  assert.deepEqual(seen, [['GET', '/orgs/AgathaTrack/issue-fields', 't']]);
  assert.equal(fields.stage.options.length, 8);
  await assert.rejects(
    loadOrgFields({ org: 'o', token: 't', restFn: async () => orgFieldDefs().slice(0, 3) }),
    /"Total N" not found/,
  );
});

test('fields: an issue\'s values parse into stage, blocked, attempts and totalN', async () => {
  const fields = await loadOrgFields({ org: 'o', token: 't', restFn: async () => orgFieldDefs() });
  const parsed = parseIssueFields(
    {
      issue_field_values: [
        { field_id: 1, single_select_option: { name: 'In analysis' } },
        { field_id: 2, single_select_option: { name: 'stalled' } },
        { field_id: 3, value: 2 },
        { field_id: 4, value: '5' },
      ],
    },
    fields,
  );
  assert.deepEqual(parsed, { stage: 'In analysis', blocked: 'stalled', attempts: 2, totalN: 5 });
  assert.deepEqual(parseIssueFields({}, fields), { stage: '', blocked: '', attempts: 0, totalN: 0 });
});

test('fields: writes use PATCH on the issue with canonical option names; typos fail before the call', async () => {
  const fields = await loadOrgFields({ org: 'o', token: 't', restFn: async () => orgFieldDefs() });
  const calls = [];
  const restFn = async (...args) => calls.push(args);
  await writeIssueFields({ owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', fields, writes: { stage: 'in analysis', attempts: 0 }, dryRun: false, restFn });
  assert.deepEqual(calls, [
    ['PATCH', '/repos/o/r/issues/7', 'pat', { issue_field_values: [{ field_id: 1, value: 'In analysis' }, { field_id: 3, value: 0 }] }],
  ]);
  assert.throws(() => buildFieldWrites(fields, { stage: 'Triage' }), /not an option of Stage/);
  assert.throws(() => buildFieldWrites(fields, { nope: 1 }), /Unknown engine field/);
});

test('fields: dry-run logs and never calls the API', async () => {
  const fields = await loadOrgFields({ org: 'o', token: 't', restFn: async () => orgFieldDefs() });
  const logs = [];
  const result = await writeIssueFields({
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', fields, writes: { blocked: 'question' }, dryRun: true,
    restFn: async () => { throw new Error('must not be called'); },
    log: (line) => logs.push(JSON.parse(line)),
  });
  assert.equal(result.dryRun, true);
  assert.deepEqual(logs[0], { event: 'pipeline_v2_field_write', dry_run: true, issue: 7, writes: { blocked: 'question' } });
});

function boardIo(extra = {}) {
  const issues = {
    1: { number: 1, body: 'a', labels: [{ name: 'task' }], issue_field_values: [{ field_id: 1, single_select_option: { name: 'To do' } }] },
    2: { number: 2, body: 'b', labels: [{ name: 'manual-only' }], issue_field_values: [{ field_id: 1, single_select_option: { name: 'In progress' } }] },
    3: { number: 3, body: 'c', labels: [], issue_field_values: [] },
  };
  return {
    config,
    fields: {
      stage: { id: 1, name: 'Stage', options: [] },
      blocked: { id: 2, name: 'Blocked', options: [] },
      attempts: { id: 3, name: 'Attempts', options: [] },
      totalN: { id: 4, name: 'Total N', options: [] },
    },
    listProjectIssues: async () => [
      { issue: { number: 1, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } },
      { issue: { number: 2, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } },
      { issue: { number: 3, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } },
      { issue: { number: 9, state: 'CLOSED', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } },
      { issue: { number: 8, state: 'OPEN', repository: { name: 'Other', owner: { login: 'AgathaTrack' } } } },
      { issue: { number: 7, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'SomeoneElse' } } } },
    ],
    getIssue: async (n) => issues[n],
    listIssueComments: async () => [],
    listCommentReactions: async () => [],
    ...extra,
  };
}

test('runner: off does nothing; dry-run decides over the board and never writes', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  const args = { owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S' };
  try {
    process.env.ISSUE_PIPELINE_V2 = 'off';
    const off = await tick({ ...args, io: boardIo({ listProjectIssues: async () => { throw new Error('no board read when off'); } }) });
    assert.equal(off.skipped, true);

    process.env.ISSUE_PIPELINE_V2 = 'on';
    assert.equal(WRITES_ENABLED, false);
    const result = await tick({ ...args, io: boardIo() });
    assert.equal(result.issueCount, 3, 'closed, other-repo and same-name-other-owner issues are not read');
    assert.equal(result.wip, 0, 'manual-only issues do not take WIP');
    const byIssue = Object.fromEntries(result.actions.map((entry) => [entry.issue, entry.action]));
    assert.equal(byIssue[1].type, 'request-spec');
    assert.equal(byIssue[2].reason, 'manual-only');
    assert.equal(byIssue[3].reason, 'stage-backlog');

    const only = await tick({ ...args, only: 1, io: boardIo() });
    assert.equal(only.actions.length, 1);
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('writes: stage and blocked changes, attempts on reassign, and the counter even when nothing else changes', () => {
  const parsed = { attempts: 0, totalN: 0 };
  assert.deepEqual(buildWrites({ action: { type: 'set-stage', to: 'Ready' }, parsed, counters: {} }), { stage: 'Ready', attempts: 0 });
  assert.deepEqual(buildWrites({ action: { type: 'set-blocked', reason: 'stalled' }, parsed, counters: {} }), { blocked: 'stalled' });
  assert.deepEqual(buildWrites({ action: { type: 'reassign', attempts: 1 }, parsed, counters: {} }), { attempts: 1 });
  assert.deepEqual(buildWrites({ action: { type: 'reassign', attempts: 0 }, parsed, counters: {} }), {}, 'unchanged attempts are not rewritten');
  assert.deepEqual(buildWrites({ action: { type: 'none' }, parsed, counters: { totalN: 3 } }), { totalN: 3 });
  assert.deepEqual(buildWrites({ action: { type: 'set-stage', to: 'Ready' }, parsed, counters: { totalN: 2 } }), { stage: 'Ready', attempts: 0, totalN: 2 });
  assert.deepEqual(buildWrites({ action: { type: 'none' }, parsed, counters: {} }), {});
});

test('runner: a counter-only change reaches the writer (as a dry run while writes are disabled)', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'on';
  const written = [];
  try {
    const stale = { number: 4, body: 'x', labels: [], issue_field_values: [{ field_id: 1, single_select_option: { name: 'In analysis' } }, { field_id: 4, value: 0 }] };
    const io = boardIo({
      listProjectIssues: async () => [{ issue: { number: 4, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
      getIssue: async () => stale,
      writeIssueFields: async (args) => { written.push(args); },
    });
    io.config = { ...io.config, engine: { logins: ['engine'] } };
    // an agent edit after the first request counts as one vote, so Total N should read 1
    io.listIssueComments = async () => [{
      id: 5, node_id: 'N5', user: { login: 'engine' }, created_at: '2026-11-16T09:00:00Z', updated_at: '2026-11-16T09:00:00Z',
      body: '<!-- v2:review-request hash=other assigned=pawpet-bot history= -->',
    }];
    io.fetchBodyEdits = async () => ({ author: 'KanopeeKa', edits: [{ editor: 'pawpet-claude', editedAt: '2026-11-16T09:30:00Z' }] });
    await tick({ owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', io });
    assert.equal(written.length, 1);
    assert.equal(written[0].dryRun, true, 'writes stay disabled in run A');
    assert.equal(written[0].writes.totalN, 1);
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});
