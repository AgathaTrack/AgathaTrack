'use strict';

// #2553 P3: the delivery WIP limit holds across ticks. A slot is held by an In progress issue the
// engine started, and by a Ready issue whose delivery launch is in flight (handed off with `busy`,
// or started inside the acknowledge window). A failed read holds a slot; it never frees one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { countEngineWip } = require('./issue_pipeline_v2_tick_facts');
const { tick } = require('./issue_pipeline_v2');

const config = loadConfig();
const ENGINE = config.engine.logins;
const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const ACK_MS = config.limits.ackWindowMin * MIN;

const engineLaunch = (id, at, { kind = 'launch', runId = `run-${id}` } = {}) => ({
  id,
  user: { login: ENGINE[0] },
  created_at: new Date(at).toISOString(),
  body:
    kind === 'launch'
      ? `<!-- v2:launch run=${runId} agent=cursor-a purpose=delivery -->\nStarted.`
      : `<!-- v2:${kind} agent=cursor-a purpose=delivery -->\nStarting.`,
});

const countWith = (entries, commentsOf, now = NOW) =>
  countEngineWip({ entries, commentsOf, engineLogins: ENGINE, now, ackWindowMs: ACK_MS });

test('an unreadable issue holds a slot: a failed read never grants capacity', async () => {
  const entries = [
    { number: 1, stage: 'In progress', labels: [], closed: false },
    { number: 2, stage: 'Ready', labels: [], closed: false },
  ];
  const broken = async () => {
    throw new Error('GitHub 502');
  };
  assert.equal(await countWith(entries, broken), 2);
});

test('a Ready issue with a delivery launch in flight holds a slot; busy alone is not enough', async () => {
  const entries = [
    { number: 1, stage: 'Ready', labels: ['busy'], closed: false },
    { number: 2, stage: 'Ready', labels: [], closed: false },
    { number: 3, stage: 'Ready', labels: ['busy'], closed: false },
  ];
  const comments = {
    1: [engineLaunch(10, NOW - 1000)],
    2: [engineLaunch(20, NOW - 1000)],
    3: [], // a human set `busy`: no engine launch, so no slot
  };
  assert.equal(await countWith(entries, async (entry) => comments[entry.number] || []), 2, 'issues 1 (busy) and 2 (in the ack window)');
});

test('lost acknowledgment: a run inside the window holds its slot, and releases it once the window has passed', async () => {
  const entries = [{ number: 1, stage: 'Ready', labels: [], closed: false }];
  const inWindow = [engineLaunch(10, NOW - ACK_MS / 2)];
  const expired = [engineLaunch(10, NOW - ACK_MS - MIN)];
  assert.equal(await countWith(entries, async () => inWindow), 1);
  assert.equal(await countWith(entries, async () => expired), 0, 'a failed start after the window does not hold a slot');
});

test('a failed start with no run (launch-failed) does not hold a slot', async () => {
  const entries = [{ number: 1, stage: 'Ready', labels: [], closed: false }];
  assert.equal(await countWith(entries, async () => [engineLaunch(10, NOW - 1000, { kind: 'launch-failed' })]), 0);
});

test('one issue counts once even when it has both an engine record and busy; manual-only and hand-driven work do not count', async () => {
  const entries = [
    { number: 1, stage: 'In progress', labels: ['busy'], closed: false },
    { number: 2, stage: 'In progress', labels: ['manual-only'], closed: false },
    { number: 3, stage: 'In progress', labels: [], closed: false }, // hand-driven: no engine record
  ];
  const comments = { 1: [engineLaunch(10, NOW - 1000)], 2: [engineLaunch(20, NOW - 1000)], 3: [] };
  assert.equal(await countWith(entries, async (entry) => comments[entry.number]), 1);
});

// Multi-tick replay: a fake board carries state between ticks. Launches add the engine record and
// `busy`; `set-stage` moves the card. Four Ready issues, limit 2, both board orders.
function replayBoard(order) {
  const world = {
    issues: Object.fromEntries(
      [1, 2, 3, 4].map((number) => [number, { number, body: '', labels: [], stage: 'Ready', comments: [] }]),
    ),
    launched: [],
  };
  const field = (name) => [{ field_id: 1, single_select_option: { name } }];
  const io = {
    config,
    fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
    listProjectIssues: async () =>
      order.map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } })),
    getIssue: async (n) => {
      const card = world.issues[n];
      return { number: n, body: '', labels: card.labels.map((name) => ({ name })), issue_field_values: field(card.stage) };
    },
    listIssueComments: async ({ issueNumber }) => world.issues[issueNumber].comments,
    listCommentReactions: async () => [],
    applyAction: async ({ action, ctx }) => {
      const card = world.issues[ctx.issueNumber];
      if (action.type === 'launch') {
        world.launched.push(ctx.issueNumber);
        card.labels = [...new Set([...card.labels, 'busy'])];
        card.comments.push(engineLaunch(`${ctx.issueNumber}-${world.launched.length}`, Date.now()));
        return { applied: [`launch:${action.agent}`], calls: [] };
      }
      if (action.type === 'set-stage') {
        card.stage = action.to;
        return { applied: [`stage:${action.to}`], calls: [] };
      }
      return { applied: [], calls: [] };
    },
    restFn: async () => ({}),
  };
  return { world, io };
}

async function runTick(io) {
  return tick({ owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', io });
}

for (const order of [
  [1, 2, 3, 4],
  [4, 3, 2, 1],
]) {
  test(`multi-tick, board order ${order.join(',')}: no third delivery while two are active; one finished frees exactly one slot`, async () => {
    const prior = process.env.ISSUE_PIPELINE_V2;
    process.env.ISSUE_PIPELINE_V2 = 'dry-run';
    try {
      const { world, io } = replayBoard(order);

      await runTick(io);
      assert.equal(world.launched.length, 2, 'tick 1 launches the first two');

      await runTick(io);
      assert.equal(world.launched.length, 2, 'tick 2: the two in flight hold both slots, so no third delivery');

      // One delivery finishes: its card leaves In progress. Exactly one more may start.
      const finished = world.launched[0];
      world.issues[finished].stage = 'In analysis';
      await runTick(io);
      assert.equal(world.launched.length, 3, 'tick 3 frees exactly one slot');
      assert.ok(!world.launched.slice(2).includes(finished), 'the finished issue is not relaunched');
    } finally {
      if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
      else process.env.ISSUE_PIPELINE_V2 = prior;
    }
  });
}
