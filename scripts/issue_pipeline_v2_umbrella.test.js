'use strict';

// Umbrella rollup (PIPE-UMB-D-001): an issue with sub-issues moves In progress → In Main and
// In Main → In UAT only when every sub-issue is at In Main, In UAT or Done.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');
const {
  isReadyStage,
  childBlockers,
  listSubIssues,
  umbrellaRollup,
  describeBlockers,
} = require('./issue_pipeline_v2_umbrella');

const config = loadConfig();
const NOW = Date.parse('2026-11-26T10:00:00Z');
const SHA = 'a'.repeat(40);

test('only In Main, In UAT and Done let an umbrella move on', () => {
  for (const stage of ['In Main', 'in uat', ' Done ']) {
    assert.equal(isReadyStage(stage), true, stage);
  }
  for (const stage of ['To do', 'In progress', 'Ready', 'In analysis', 'Backlog', '', null, undefined]) {
    assert.equal(isReadyStage(stage), false, String(stage));
  }
});

test('a sub-issue closed as not planned is no blocker; an empty Stage blocks as Backlog', () => {
  const blockers = childBlockers([
    { number: 1, state: 'closed', stateReason: 'not_planned', stage: null },
    { number: 2, state: 'closed', stateReason: 'completed', stage: 'Done' },
    { number: 3, state: 'open', stateReason: null, stage: 'In UAT' },
    { number: 4, state: 'open', stateReason: null, stage: 'In progress' },
    { number: 5, state: 'open', stateReason: null, stage: '' },
  ]);
  assert.deepEqual(blockers, [
    { number: 4, stage: 'In progress' },
    { number: 5, stage: 'Backlog' },
  ]);
  assert.equal(describeBlockers(blockers), '#4 (In progress), #5 (Backlog)');
});

test('listSubIssues follows pages and reports state and state_reason', async () => {
  const calls = [];
  const restFn = async (method, path) => {
    calls.push(path);
    // Match the last query parameter exactly: `per_page=100` also contains `page=1`.
    if (path.endsWith('&page=1')) {
      return Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'open', state_reason: null }));
    }
    return [{ number: 101, state: 'closed', state_reason: 'not_planned' }];
  };
  const subs = await listSubIssues({ owner: 'o', repo: 'r', issueNumber: 9, token: 't', restFn });
  assert.equal(subs.length, 101);
  assert.deepEqual(subs.at(-1), { number: 101, state: 'closed', stateReason: 'not_planned' });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/repos\/o\/r\/issues\/9\/sub_issues\?per_page=100&page=1$/);
});

test('a sub-issue list that never ends is an error, not a short list that under-counts blockers', async () => {
  const restFn = async () => Array.from({ length: 100 }, (_, i) => ({ number: i + 1, state: 'open' }));
  await assert.rejects(
    () => listSubIssues({ owner: 'o', repo: 'r', issueNumber: 9, token: 't', restFn }),
    /longer than/,
  );
});

test('umbrellaRollup reads each sub-issue stage and returns only the blockers', async () => {
  const stages = { 11: 'In Main', 12: 'To do' };
  const read = [];
  const restFn = async () => [
    { number: 11, state: 'closed', state_reason: 'completed' },
    { number: 12, state: 'open', state_reason: null },
    { number: 13, state: 'closed', state_reason: 'not_planned' },
  ];
  const rollup = await umbrellaRollup({
    owner: 'o',
    repo: 'r',
    issueNumber: 2548,
    token: 't',
    restFn,
    readStage: async (number) => {
      read.push(number);
      return stages[number];
    },
  });
  assert.deepEqual(read, [11, 12], 'a not-planned sub-issue is not read');
  assert.deepEqual(rollup.blockers, [{ number: 12, stage: 'To do' }]);
});

test('an issue with no sub-issues has no blockers', async () => {
  const rollup = await umbrellaRollup({
    owner: 'o',
    repo: 'r',
    issueNumber: 7,
    token: 't',
    restFn: async () => [],
    readStage: async () => {
      throw new Error('no sub-issue should be read');
    },
  });
  assert.deepEqual(rollup, { children: [], blockers: [] });
});

// Decide-level: the engine must not move the umbrella while a sub-issue is short.

function facts(over = {}) {
  return {
    mode: 'dry-run',
    now: NOW,
    onBoard: true,
    labels: [],
    stage: 'In progress',
    blocked: '',
    bodyHash: 'h1',
    totalVotes: 0,
    wip: 0,
    ...over,
  };
}

test('In progress: a finished umbrella waits while a sub-issue is not yet In Main', () => {
  const finished = { busy: false, dodComplete: true, openLinkedPrs: 0, mergedIntoMain: 1 };
  const waiting = decide(facts({
    delivery: finished,
    umbrella: { children: [], blockers: [{ number: 2557, stage: 'In progress' }] },
  }), config);
  assert.equal(waiting.type, 'none');
  assert.equal(waiting.reason, 'progress.umbrella-waiting');
  assert.deepEqual(waiting.blockers, [{ number: 2557, stage: 'In progress' }]);

  const clear = decide(facts({ delivery: finished, umbrella: { children: [], blockers: [] } }), config);
  assert.notEqual(clear.reason, 'progress.umbrella-waiting');
  assert.equal(clear.to, 'In Main');
});

test('In Main: no intent review, acceptance or In UAT while a sub-issue is short', () => {
  const merged = { lastMergeSha: SHA };
  const waiting = decide(facts({
    stage: 'In Main',
    delivery: merged,
    uatContainsLatestMerge: true,
    umbrella: { children: [], blockers: [{ number: 2411, stage: 'To do' }] },
  }), config);
  assert.equal(waiting.type, 'none');
  assert.equal(waiting.reason, 'main.umbrella-waiting');
  assert.notEqual(waiting.type, 'set-stage');
  assert.notEqual(waiting.type, 'request-intent-review');
});

test('In Main: a plain issue (no umbrella facts) is not held by the rollup', () => {
  const action = decide(facts({
    stage: 'In Main',
    delivery: { lastMergeSha: SHA },
    uatContainsLatestMerge: false,
  }), config);
  assert.notEqual(action.reason, 'main.umbrella-waiting');
});
