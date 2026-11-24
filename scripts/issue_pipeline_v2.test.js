'use strict';

const { roundsFromReview } = require('./issue_pipeline_v2_round_fixtures');

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyWipOverride, loadConfig, validateConfig } = require('./issue_pipeline_v2_config');
const { decide, canonicalStage } = require('./issue_pipeline_v2_decide');
const {
  loadOrgFields,
  parseIssueFields,
  buildFieldWrites,
  writeIssueFields,
} = require('./issue_pipeline_v2_fields');
const { tick } = require('./issue_pipeline_v2');
const { buildWrites } = require('./issue_pipeline_v2_apply');

const config = loadConfig();
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-16T12:00:00Z');

const legacyConfig = validateConfig({
  agents: [
    { login: 'pawpet-bot', runner: 'cursor', methods: ['PR', 'light-plan', 'execute-plan'] },
    { login: 'pawpet-claude', runner: 'claude', methods: ['PR', 'light-plan'] },
  ],
  engine: { logins: ['pawpet-engine'] },
  launchRunners: ['cursor'],
  limits: config.limits,
  aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
});

function facts(over = {}) {
  const base = {
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
  // In analysis reads round records (PIPE-V2-D-REV3-007); build them from the legacy review shape.
  if (base.stage === 'In analysis' && base.rounds === undefined) {
    base.rounds = roundsFromReview(base.review, base.bodyHash);
  }
  return base;
}

const rowOf = (over) => decide(facts(over), legacyConfig);
// Both runners startable: the ring includes every startable agent.
const bothStartable = { ...legacyConfig, launchRunners: ['cursor', 'claude'] };
const rowOfBoth = (over) => decide(facts(over), bothStartable);

test('config: the committed file is valid; bad edits are reported together', () => {
  assert.equal(config.agents.length, 4);
  assert.equal(config.agents[3].id, 'claude-b', 'P2 adds claude-b after the existing three');
  assert.equal(config.agents[0].id, 'cursor-a');
  assert.equal(config.agents[0].actsAs, 'pawpet-bot');
  assert.equal(config.agents[1].model, 'grok-4.7-medium');
  assert.throws(
    () => validateConfig({ agents: [{ login: 'a', methods: ['nope'] }], limits: {} }),
    /at least two listed agents[\s\S]*unknown method nope[\s\S]*limits\.wip/,
  );
});

test('config: explicit id and actsAs; engine token must not match actsAs', () => {
  const limits = { ...config.limits };
  assert.doesNotThrow(() =>
    validateConfig({
      agents: [
        { id: 'cursor-a', actsAs: 'pawpet-bot', runner: 'cursor', methods: ['PR'] },
        { id: 'claude-a', actsAs: 'pawpet-claude', runner: 'claude', methods: ['PR'] },
      ],
      engine: { logins: ['pawpet-engine'] },
      launchRunners: ['cursor'],
      limits,
      aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        agents: [
          { id: 'cursor-a', actsAs: 'pawpet-bot', runner: 'cursor', methods: ['PR'] },
          { id: 'claude-a', actsAs: 'pawpet-claude', runner: 'claude', methods: ['PR'] },
        ],
        engine: { logins: ['pawpet-bot'] },
        launchRunners: ['cursor'],
        limits,
        aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
      }),
    /actsAs/,
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
  const wake = rowOf({ blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 7 });
  assert.deepEqual([wake.type, wake.stage, wake.row, wake.commentId], ['wake-stage-agent', 'To do', 'blocked.wake', 7]);
  assert.equal(wake.agent, 'pawpet-bot', 'with no request holder the ring starts at the first startable agent');
  assert.equal(
    rowOf({ blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 7, spec: { assignedTo: 'pawpet-claude' } }).agent,
    'pawpet-bot',
    'a holder the engine cannot start is not woken; a startable agent is',
  );
  assert.equal(
    rowOfBoth({ blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 7, spec: { assignedTo: 'pawpet-claude' } }).agent,
    'pawpet-claude',
    'a startable holder is the one woken',
  );
  assert.equal(
    decide(facts({ blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 7 }), { ...config, launchRunners: ['nobody'] }).reason,
    'blocked.no-agent',
  );
  // a human comment is answered once
  const again = rowOf({ blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 7, wokenFor: [7] });
  assert.deepEqual([again.type, again.reason], ['none', 'blocked.already-woken']);
  assert.equal(rowOf({ blocked: 'question', humanCommentSinceBlock: true, humanCommentId: 8, wokenFor: [7] }).type, 'wake-stage-agent');
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

test('pickup rotation only draws from agents the engine can start (launchRunners)', () => {
  const claude = 'pawpet-claude';
  const picks = [
    rowOf({ agentLastUsed: { 'pawpet-bot': NOW - MIN, [claude]: NOW - 99 * MIN } }),
    rowOf({ stage: 'In analysis', lastBodyEditor: null, review: {}, agentLastUsed: { 'pawpet-bot': NOW - MIN } }),
    rowOf({ stage: 'In Main', delivery: { lastMergeSha: 'm1' }, prAuthors: ['pawpet-bot'] }),
  ];
  for (const action of picks) {
    assert.equal(action.agent, 'pawpet-bot', action.row);
  }
  const held = rowOf({ spec: { requestedAt: NOW - 5 * MIN, assignedTo: 'pawpet-claude' } });
  assert.deepEqual([held.type, held.agent, held.row], ['reassign', 'pawpet-bot', 'todo.reassign'], 'a non-startable assignee does not sit out the timeout');
  for (const stage of ['To do', 'In analysis']) {
    const key = stage === 'To do' ? 'spec' : 'review';
    const late = rowOf({ stage, lastBodyEditor: null, [key]: { requestedHash: 'h1', requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-bot' } });
    assert.deepEqual([late.type, late.reason], ['set-blocked', 'stalled'], stage);
  }
});

test('queued label retries the doorbell for the held assignee', () => {
  const action = decide(facts({
    labels: ['queued'],
    stage: 'In analysis',
    review: { requestedHash: 'h1', requestedAt: NOW - 5 * MIN, assignedTo: 'claude-a' },
  }), config);
  assert.deepEqual([action.type, action.agent, action.row], ['ring-doorbell', 'claude-a', 'analysis.runner-queued']);
});

test('queued does not ring-doorbell while busy holds the active run', () => {
  const action = decide(facts({
    labels: ['queued', 'busy'],
    stage: 'In analysis',
    review: { requestedHash: 'h1', requestedAt: NOW - 5 * MIN, assignedTo: 'claude-a' },
  }), config);
  // busy doubles the silence window, so the round is still waiting (soak-6 hold).
  assert.equal(action.reason, 'analysis.round-waiting');
});

test('In Main retries queued intent-review doorbell before waiting on UAT', () => {
  const action = decide(facts({
    labels: ['queued'],
    stage: 'In Main',
    delivery: { lastMergeSha: 'a'.repeat(40) },
    intentReview: { requested: true, agent: 'claude-a', requestedAt: NOW - 5 * MIN },
    uatContainsLatestMerge: false,
  }), config);
  assert.deepEqual([action.type, action.agent, action.stage], ['ring-doorbell', 'claude-a', 'In Main']);
});

test('queued label past pickup timeout reassigns instead of endless ring-doorbell', () => {
  const action = decide(facts({
    labels: ['queued'],
    stage: 'In analysis',
    review: { requestedHash: 'h1', requestedAt: NOW - 31 * MIN, assignedTo: 'claude-a' },
  }), config);
  assert.equal(action.type, 'reassign', action.row);
});

test('queued with ringFailed reassigns once queued is cleared on a real doorbell failure', () => {
  const action = decide(facts({
    labels: [],
    stage: 'In analysis',
    review: {
      requestedHash: 'h1',
      requestedAt: NOW - 10 * MIN,
      assignedTo: 'claude-a',
      ringFailed: true,
    },
  }), config);
  assert.equal(action.type, 'reassign', action.row);
});

test('To do: request, wait, reassign, stall, pass', () => {
  assert.equal(rowOfBoth({}).type, 'request-spec');
  const base = { spec: { requestedAt: NOW - 5 * MIN, assignedTo: 'pawpet-bot' } };
  assert.equal(rowOfBoth(base).reason, 'todo.waiting');
  const late = { spec: { requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-bot', timedOut: [] } };
  assert.deepEqual(
    [rowOfBoth(late).type, rowOfBoth(late).agent],
    ['reassign', 'pawpet-claude'],
  );
  const lateBusy = {
    labels: ['busy'],
    spec: { requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-bot', timedOut: [] },
  };
  assert.equal(rowOfBoth(lateBusy).reason, 'todo.waiting-busy');
  const allLate = {
    spec: { requestedAt: NOW - 31 * MIN, assignedTo: 'pawpet-claude', timedOut: ['pawpet-bot'] },
  };
  assert.equal(rowOfBoth(allLate).reason, 'stalled');
  assert.equal(rowOfBoth({ spec: { passedBy: 'pawpet-bot' } }).to, 'In analysis');
});

test('To do: no history starts at the first agent; the next assignment is the next in the ring', () => {
  assert.equal(rowOfBoth({}).agent, 'pawpet-bot');
  const action = rowOfBoth({
    roundRobinAfter: 'pawpet-bot',
    roundRobinOrder: ['pawpet-bot', 'pawpet-claude'],
  });
  assert.equal(action.agent, 'pawpet-claude');
});

const vote = (login, v, hash = 'h1') => ({ login, vote: v, hash });

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

test('WIP_LIMIT=off lifts the Ready queue cap; any other value keeps it', () => {
  const ready = { stage: 'Ready', deliveryMethod: 'light-plan', wip: 5 };
  const decideWith = (raw) => decide(facts(ready), applyWipOverride(config, raw));
  assert.equal(decideWith(undefined).reason, 'ready.queued');
  assert.equal(decideWith('on').reason, 'ready.queued');
  assert.equal(decideWith('').reason, 'ready.queued');
  assert.equal(decideWith(' OFF ').type, 'launch');
  assert.equal(config.limits.wip, 2, 'the committed config is not mutated');
});

test('Ready: risky-scope preflight failure sets sensitive blocked instead of backoff', () => {
  const action = rowOf({
    stage: 'Ready',
    deliveryMethod: 'PR',
    launch: { failures: 1, lastFailureAt: NOW - MIN, riskyScopePreflight: true },
  });
  assert.deepEqual([action.type, action.reason, action.row], ['set-blocked', 'sensitive', 'ready.risky-scope']);
});

test('Ready: owner-approved-delivery relaunches after risky-scope preflight failure', () => {
  const ready = {
    stage: 'Ready',
    deliveryMethod: 'light-plan',
    labels: ['go', 'owner-approved-delivery'],
    launch: { failures: 1, lastFailureAt: NOW - 6 * MIN, riskyScopePreflight: true },
  };
  assert.equal(rowOf(ready).type, 'launch');
  assert.equal(rowOf(ready).row, 'ready.launch');
  assert.equal(
    rowOf({ ...ready, wip: 99 }).reason,
    'ready.queued',
    'WIP cap still applies after owner waiver',
  );
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

test('Ready: a method no agent can run is a board-level error, not a flag on the issue', () => {
  const action = rowOf({ stage: 'Ready', deliveryMethod: 'unknown' });
  assert.deepEqual([action.type, action.reason, action.boardError], ['none', 'ready.no-capable-agent', true]);
});

test('In progress: working, resume once, stalled, finished', () => {
  const stage = 'In progress';
  const busy = { busy: true, lastActivityAt: NOW - MIN };
  assert.equal(rowOf({ stage, delivery: busy }).reason, 'progress.working');
  const mine = { engineLaunched: true };
  assert.equal(rowOf({ stage, delivery: { ...mine, busy: false } }).type, 'resume');
  assert.equal(rowOf({ stage, delivery: { ...mine, busy: false, resumed: true } }).reason, 'stalled');
  assert.equal(rowOf({ stage, delivery: { ...mine, busy: true, lastActivityAt: NOW - 25 * 60 * MIN } }).type, 'resume');
  // a hand-driven issue (no engine launch record) is never restarted or blocked by the engine
  assert.equal(rowOf({ stage, delivery: { busy: false } }).reason, 'progress.hand-driven');
  assert.equal(rowOf({ stage, delivery: { busy: false, resumed: true } }).reason, 'progress.hand-driven');
  const done = { busy: false, dodComplete: true, openLinkedPrs: 0, mergedIntoMain: 1 };
  const finished = rowOf({ stage, delivery: done });
  assert.deepEqual([finished.to, finished.then], ['In Main', ['request-intent-review']]);
  // each condition is needed
  for (const missing of [{ dodComplete: false }, { openLinkedPrs: 1 }, { mergedIntoMain: 0 }, { busy: true }]) {
    assert.notEqual(rowOf({ stage, delivery: { ...done, ...missing, lastActivityAt: NOW } }).to, 'In Main');
  }
});

test('In Main without a merge into main waits instead of repeating an unsatisfiable review request', () => {
  assert.equal(rowOf({ stage: 'In Main' }).reason, 'main.no-merge');
  assert.equal(rowOf({ stage: 'In Main', delivery: {} }).reason, 'main.no-merge');
  assert.equal(rowOf({ stage: 'In Main', delivery: { lastMergeSha: null }, uatContainsLatestMerge: true }).reason, 'main.no-merge');
});

test('In Main: intent review first, from an agent that did not author the PRs, then UAT', () => {
  const merged = { delivery: { lastMergeSha: 'm1' } };
  const request = decide(facts({ stage: 'In Main', ...merged, deliveryLaunchAgentId: 'cursor-a' }), config);
  assert.deepEqual([request.type, request.agent], ['request-intent-review', 'cursor-b']);
  const onlyDeliverer = decide(facts({ stage: 'In Main', ...merged, deliveryLaunchAgentId: 'cursor-b' }), config);
  assert.equal(onlyDeliverer.type, 'request-intent-review');
  const requested = { stage: 'In Main', ...merged, intentReview: { requested: true } };
  assert.equal(rowOfBoth(requested).reason, 'main.waiting-uat');
  assert.equal(rowOfBoth({ ...requested, uatContainsLatestMerge: true }).to, 'In UAT');
  const noStartable = { stage: 'In Main', ...merged };
  const noRings = { ...bothStartable, launchRunners: [] };
  assert.equal(decide(facts(noStartable), noRings).reason, 'main.waiting-uat');
  assert.equal(decide(facts({ ...noStartable, uatContainsLatestMerge: true }), noRings).to, 'In UAT');
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
    {
      id: 2,
      name: 'Blocked',
      options: ['question', 'no-convergence', 'launch-failed', 'decision', 'stalled', 'paused', 'sensitive'].map(
        (name) => ({ name }),
      ),
    },
    { id: 3, name: 'Attempts' },
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
    loadOrgFields({ org: 'o', token: 't', restFn: async () => orgFieldDefs().slice(0, 2) }),
    /"Attempts" not found/,
  );
});

test('fields: an issue\'s values parse into stage, blocked and attempts', async () => {
  const fields = await loadOrgFields({ org: 'o', token: 't', restFn: async () => orgFieldDefs() });
  const parsed = parseIssueFields(
    {
      issue_field_values: [
        { field_id: 1, single_select_option: { name: 'In analysis' } },
        { field_id: 2, single_select_option: { name: 'stalled' } },
        { field_id: 3, value: 2 },
      ],
    },
    fields,
  );
  assert.deepEqual(parsed, { stage: 'In analysis', blocked: 'stalled', attempts: 2 });
  assert.deepEqual(parseIssueFields({}, fields), { stage: '', blocked: '', attempts: 0 });
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
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', fields,
    writes: { blocked: 'question' }, parsed: { stage: 'Ready', blocked: '', attempts: 2 }, dryRun: true,
    restFn: async () => { throw new Error('must not be called'); },
    log: (line) => logs.push(JSON.parse(line)),
  });
  assert.deepEqual(logs[0].writes, { blocked: 'question', stage: 'Ready', attempts: 2 });
  logs.length = 0;
  const result2 = await writeIssueFields({
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', fields, writes: { blocked: 'question' }, dryRun: true,
    restFn: async () => { throw new Error('must not be called'); },
    log: (line) => logs.push(JSON.parse(line)),
  });
  assert.equal(result.dryRun, true);
  assert.equal(result2.dryRun, true);
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
    const sent = [];
    const result = await tick({ ...args, io: boardIo({ restFn: async (...call) => { sent.push(call); return {}; } }) });
    assert.deepEqual(sent, [], 'no engine identity configured, so nothing is sent');
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

test('runner: WIP_LIMIT=off reaches tick; a Ready issue over the cap launches only with it', async () => {
  const prior = { mode: process.env.ISSUE_PIPELINE_V2, wip: process.env.WIP_LIMIT };
  const field = (name) => [{ field_id: 1, single_select_option: { name } }];
  const board = {
    1: { number: 1, body: '', labels: [], issue_field_values: field('Ready') },
    10: { number: 10, body: '', labels: [], issue_field_values: field('In progress') },
    11: { number: 11, body: '', labels: [], issue_field_values: field('In progress') },
    12: { number: 12, body: '', labels: [], issue_field_values: field('In progress') },
  };
  const io = boardIo({
    listProjectIssues: async () =>
      [1, 10, 11, 12].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } })),
    getIssue: async (n) => board[n],
    // WIP counts only In progress issues the engine started, so each carries an engine launch record.
    listIssueComments: async ({ issueNumber }) =>
      issueNumber >= 10
        ? [{ id: issueNumber, user: { login: 'pawpet-engine' }, created_at: '2026-11-16T10:00:00Z', body: '<!-- v2:launch run=r agent=cursor-a -->' }]
        : [],
  });
  const args = { owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', only: 1, io };
  const actionFor = async (raw) => {
    if (raw === undefined) delete process.env.WIP_LIMIT;
    else process.env.WIP_LIMIT = raw;
    const result = await tick(args);
    // A planned launch counts itself, so the total can be 4 when the Ready issue launches.
    assert.ok(result.wip >= 3, 'three In progress issues: over the committed cap of 2');
    return result.actions.find((entry) => entry.issue === 1).action;
  };
  try {
    process.env.ISSUE_PIPELINE_V2 = 'dry-run';
    assert.equal((await actionFor(undefined)).reason, 'ready.queued', 'no variable: the committed cap holds');
    assert.equal((await actionFor('on')).reason, 'ready.queued', 'any other value keeps the cap');
    assert.equal((await actionFor('off')).type, 'launch', 'WIP_LIMIT=off lets the Ready issue launch');
  } finally {
    if (prior.mode === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior.mode;
    if (prior.wip === undefined) delete process.env.WIP_LIMIT;
    else process.env.WIP_LIMIT = prior.wip;
  }
});

test('writes: stage and blocked changes, attempts on reassign, and the counter even when nothing else changes', () => {
  const parsed = { attempts: 0 };
  assert.deepEqual(buildWrites({ action: { type: 'set-stage', to: 'Ready' }, parsed, counters: {} }), { stage: 'Ready', attempts: 0 });
  assert.deepEqual(buildWrites({ action: { type: 'set-blocked', reason: 'stalled' }, parsed, counters: {} }), { blocked: 'stalled' });
  assert.deepEqual(buildWrites({ action: { type: 'reassign', attempts: 1 }, parsed, counters: {} }), { attempts: 1 });
  assert.deepEqual(buildWrites({ action: { type: 'reassign', attempts: 0 }, parsed, counters: {} }), {}, 'unchanged attempts are not rewritten');
  assert.deepEqual(buildWrites({ action: { type: 'none' }, parsed, counters: {} }), {});
});

test('runner: a counter-only change reaches the applier (as a dry run without an engine identity)', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'on';
  const written = [];
  try {
    const stale = { number: 4, body: 'x', labels: [], issue_field_values: [{ field_id: 1, single_select_option: { name: 'In analysis' } }, { field_id: 4, value: 0 }] };
    const io = boardIo({
      listProjectIssues: async () => [{ issue: { number: 4, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
      getIssue: async () => stale,
      applyAction: async (args) => { written.push(args); return { applied: [], calls: [] }; },
    });
    io.config = { ...io.config, engine: { logins: ['engine'] } };
    io.listIssueComments = async () => [{
      id: 5, node_id: 'N5', user: { login: 'engine' }, created_at: '2026-11-16T09:00:00Z', updated_at: '2026-11-16T09:00:00Z',
      body: '<!-- v2:review-request hash=other assigned=pawpet-bot history= -->',
    }];
    io.fetchBodyEdits = async () => ({ author: 'KanopeeKa', edits: [{ editor: 'pawpet-claude', editedAt: '2026-11-16T09:30:00Z' }] });
    await tick({ owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', io });
    assert.equal(written.length, 1);
    assert.equal(written[0].ctx.dryRun, true, 'the token is not a configured engine identity');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});
