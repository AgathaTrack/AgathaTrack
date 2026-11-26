'use strict';

// Pipeline v2 holds (PIPE-V2-D-HOLD-001 to 005): engine holds are re-evaluated and released by the
// engine, a human clear is a retry, and the attempt markers before a release stop counting.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { deriveAatState } = require('./issue_pipeline_v2_acceptance');
const { deriveRoundRecords } = require('./issue_pipeline_v2_round_facts');
const { tick } = require('./issue_pipeline_v2');
const {
  deriveHoldFacts, holdCleared, sinceRelease, buildHold, buildRelease, isEngineHold,
} = require('./issue_pipeline_v2_holds');

const loaded = loadConfig();
const config = { ...loaded, aat: { enabled: true, timeoutMin: 120, maxInconclusive: 2 } };
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const NOW = Date.parse('2026-11-24T20:00:00Z');
const ENGINE = 'pawpet-engine';
const AGENT = 'pawpet-bot';
let seq = 1;

function comment(login, body, minutesAgo) {
  const created_at = new Date(NOW - minutesAgo * 60 * 1000).toISOString();
  seq += 1;
  return { id: seq, user: { login }, created_at, updated_at: created_at, body };
}
const launch = (sha, ago, extra = 'run=r1') => comment(ENGINE, `<!-- v2:aat-launch merge=${sha} ${extra} -->`, ago);
const inconclusive = (sha, ago) => comment(AGENT, `<!-- v2:aat verdict=inconclusive merge=${sha} -->`, ago);
const hold = (reason, ago) => comment(ENGINE, buildHold({ reason, row: 'aat.inconclusive-cap' }), ago);
const release = (by, ago) => comment(ENGINE, buildRelease({ by, from: 'stalled', cause: 'x' }), ago);

/** In Main facts the way the runner builds them: holds from all comments, attempts since the release. */
function inMain(comments, over = {}) {
  const holds = deriveHoldFacts(comments, [ENGINE]);
  const counted = sinceRelease(comments, over.stage || 'In Main', holds.releasedAt, [ENGINE]);
  return decide({
    mode: 'dry-run',
    now: NOW,
    onBoard: true,
    labels: [],
    stage: 'In Main',
    blocked: '',
    aatFieldsPresent: true,
    isFollowUp: false,
    acceptance: '',
    delivery: { lastMergeSha: SHA, lastActivityAt: NOW, busy: false, openLinkedPrs: 0 },
    holds,
    aat: deriveAatState({ comments: counted, engineLogins: [ENGINE], agentLogins: [AGENT] }),
    ...over,
  }, config);
}

const capped = [launch(SHA, 600), inconclusive(SHA, 500), launch(SHA, 400, 'run=r2'), inconclusive(SHA, 300)];

test('only stalled and launch-failed are engine holds', () => {
  assert.equal(isEngineHold('stalled'), true);
  assert.equal(isEngineHold(' Launch-failed '), true);
  for (const value of ['question', 'decision', 'no-convergence', 'sensitive', 'paused', '']) {
    assert.equal(isEngineHold(value), false, value);
  }
});

test('an engine hold whose rule is still exhausted stays; a human comment still wakes the stage agent', () => {
  const comments = [...capped, hold('stalled', 200)];
  assert.equal(inMain(comments, { blocked: 'stalled' }).reason, 'blocked');
  const woken = inMain(comments, { blocked: 'stalled', humanCommentSinceBlock: true, humanCommentId: 9, wokenFor: [] });
  assert.equal(woken.type, 'wake-stage-agent');
});

test('#2554: a newer merge releases an engine hold set at the old merge cap', () => {
  const comments = [...capped, hold('stalled', 200)];
  const action = inMain(comments, { blocked: 'stalled', delivery: { lastMergeSha: SHA2, lastActivityAt: NOW, busy: false, openLinkedPrs: 0 } });
  assert.deepEqual([action.type, action.by, action.from, action.cause], ['release-hold', 'engine', 'stalled', 'aat.launch']);
});

test('a hold set before this change (no v2:hold marker) is released the same way', () => {
  const action = inMain(capped, { blocked: 'stalled', delivery: { lastMergeSha: SHA2, lastActivityAt: NOW, busy: false, openLinkedPrs: 0 } });
  assert.equal(action.type, 'release-hold');
});

test('owner holds and human holds are never re-evaluated', () => {
  const newMerge = { lastMergeSha: SHA2, lastActivityAt: NOW, busy: false, openLinkedPrs: 0 };
  assert.equal(inMain(capped, { blocked: 'paused', delivery: newMerge }).reason, 'blocked.paused');
  assert.equal(inMain(capped, { blocked: 'question', delivery: newMerge }).reason, 'blocked');
});

test('an engine hold is kept while no agent can take the work (board-level error)', () => {
  const action = decide({
    mode: 'dry-run', now: NOW, onBoard: true, labels: [], stage: 'In progress', blocked: 'stalled',
    deliveryMethod: 'carrier', delivery: { busy: false, engineLaunched: true },
  }, config);
  assert.equal(action.reason, 'blocked');
});

test('an engine hold can turn into a human hold', () => {
  const action = decide({
    mode: 'dry-run', now: NOW, onBoard: true, labels: [], stage: 'Ready', blocked: 'launch-failed',
    launch: { riskyScopePreflight: true, failures: 0 },
  }, config);
  assert.deepEqual([action.type, action.reason], ['set-blocked', 'sensitive']);
});

test('a human clear is a retry: recorded once, then the cap counts only launches after it', () => {
  const held = [...capped, hold('stalled', 200)];
  // Cleared by hand: Blocked is empty and the hold has no release after it.
  assert.equal(holdCleared({ blocked: '', holds: deriveHoldFacts(held, [ENGINE]) }), true);
  const cleared = inMain(held);
  assert.deepEqual([cleared.type, cleared.by, cleared.row], ['release-hold', 'human', 'blocked.cleared']);
  // After the release marker: the earlier launches no longer count, so acceptance starts again.
  const retried = inMain([...held, release('human', 100)]);
  assert.deepEqual([retried.type, retried.row], ['launch-aat', 'aat.launch']);
  // Without the release, the same facts are back at the cap.
  assert.equal(inMain(capped).row, 'aat.inconclusive-cap');
});

test('sinceRelease drops only the stage attempt markers older than the release', () => {
  const old = launch(SHA, 300);
  const verdict = inconclusive(SHA, 250);
  const fresh = launch(SHA, 50);
  const released = release('human', 100);
  const kept = sinceRelease([old, verdict, released, fresh], 'In Main', Date.parse(released.created_at), [ENGINE]);
  assert.deepEqual(kept.map((c) => c.id), [verdict.id, released.id, fresh.id]);
  assert.equal(sinceRelease([old], 'In UAT', Date.parse(released.created_at), [ENGINE]).length, 1, 'no attempt markers in In UAT');
  const resume = comment(ENGINE, '<!-- v2:resume agent=a ok=1 -->', 300);
  assert.equal(sinceRelease([resume], 'In progress', Date.parse(released.created_at), [ENGINE]).length, 0);
  const notEngine = comment(AGENT, '<!-- v2:resume agent=a ok=1 -->', 300);
  assert.equal(sinceRelease([notEngine], 'In progress', Date.parse(released.created_at), [ENGINE]).length, 1);
});

test('In analysis: a release after the last request gives the stalled round one more attempt', () => {
  const requestAt = NOW - 120 * 60 * 1000;
  const input = {
    spec: { author: 'cursor-a', hash: 'h1' },
    requests: [{ hash: 'h1', assigned: 'claude-a', history: ['cursor-a'], at: requestAt }],
    bodyHash: 'h1',
  };
  assert.equal(deriveRoundRecords(input).at(-1).attempts.length, 2);
  assert.equal(deriveRoundRecords({ ...input, releasedAt: requestAt + 1 }).at(-1).attempts.length, 1);
  assert.equal(deriveRoundRecords({ ...input, releasedAt: requestAt - 1 }).at(-1).attempts.length, 2, 'an older release changes nothing');
});

const FIELDS = {
  stage: { id: 1, name: 'Stage', options: ['In Main'] },
  blocked: { id: 2, name: 'Blocked', options: ['stalled', 'sensitive'] },
  attempts: { id: 3, name: 'Attempts', options: [] },
};

test('apply: an engine hold posts v2:hold; a human hold does not', async () => {
  const sent = [];
  const ctx = {
    owner: 'o', repo: 'r', issueNumber: 7, token: 'p', config, fields: FIELDS, parsed: {}, assignees: [], facts: {}, dryRun: false,
    restFn: async (method, path, token, body) => { sent.push({ method, path, body }); return method === 'GET' ? { issue_field_values: [] } : {}; },
  };
  await applyAction({ action: { type: 'set-blocked', reason: 'stalled', row: 'aat.inconclusive-cap' }, ctx });
  assert.ok(sent.some((call) => /v2:hold reason=stalled row=aat.inconclusive-cap/.test(call.body?.body || '')));
  sent.length = 0;
  await applyAction({ action: { type: 'set-blocked', reason: 'sensitive', row: 'ready.risky-scope' }, ctx });
  assert.ok(!sent.some((call) => /v2:hold/.test(call.body?.body || '')));
});

test('apply: an engine release clears Blocked and Attempts; a human release only records the marker', async () => {
  const fields = {
    stage: { id: 1, name: 'Stage', options: ['In Main'] },
    blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
    attempts: { id: 3, name: 'Attempts', options: [] },
  };
  const current = { issue_field_values: [
    { field_id: 1, single_select_option: { name: 'In Main' } },
    { field_id: 2, single_select_option: { name: 'stalled' } },
    { field_id: 3, value: 2 },
  ] };
  const run = async (action) => {
    const sent = [];
    await applyAction({
      action,
      ctx: {
        owner: 'o', repo: 'r', issueNumber: 7, token: 'p', config, fields,
        parsed: { stage: 'In Main', blocked: 'stalled', attempts: 2 }, assignees: [], facts: {}, dryRun: false,
        restFn: async (method, path, token, body) => { sent.push({ method, path, body }); return method === 'GET' ? current : {}; },
      },
    });
    return sent;
  };
  const engine = await run({ type: 'release-hold', by: 'engine', from: 'stalled', cause: 'aat.launch', row: 'blocked.release' });
  assert.ok(engine.some((call) => /v2:release by=engine from=stalled cause=aat.launch/.test(call.body?.body || '')));
  const patch = engine.find((call) => call.method === 'PATCH').body.issue_field_values;
  assert.equal(patch.find((v) => v.field_id === 2), undefined, 'Blocked is cleared');
  assert.equal(patch.find((v) => v.field_id === 3).value, 0, 'Attempts restart');
  assert.equal(patch.find((v) => v.field_id === 1).value, 'In Main', 'Stage is carried');
  const human = await run({ type: 'release-hold', by: 'human', from: 'stalled', row: 'blocked.cleared' });
  assert.ok(human.some((call) => /v2:release by=human from=stalled/.test(call.body?.body || '')));
});

test('runner: a stalled issue is read in full, so a merged PR moves it out of the hold', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  try {
    const result = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config: { ...loaded, engine: { logins: [ENGINE] } },
        umbrellaRollup: async () => ({ children: [], blockers: [] }), // no sub-issues: no network read
        fields: {
          stage: { id: 1, name: 'Stage', options: [] },
          blocked: { id: 2, name: 'Blocked', options: [] },
          attempts: { id: 3, name: 'Attempts', options: [] },
        },
        listProjectIssues: async () => [{ issue: { number: 1, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
        getIssue: async () => ({
          number: 1, body: '', labels: [],
          issue_field_values: [
            { field_id: 1, single_select_option: { name: 'In progress' } },
            { field_id: 2, single_select_option: { name: 'stalled' } },
          ],
        }),
        listIssueComments: async () => [
          comment(ENGINE, '<!-- v2:launch run=r1 agent=cursor-a purpose=delivery -->', 3000),
          comment(ENGINE, '<!-- v2:resume agent=cursor-a ok=1 -->', 2000),
        ],
        listLinkedPrs: async () => [{ number: 5, state: 'closed', merged: true, mergedAt: '2026-11-24T00:00:00Z', mergeSha: 'm1', base: 'main', author: AGENT, updatedAt: '2026-11-24T00:00:00Z' }],
      },
    });
    const action = result.actions[0].action;
    assert.deepEqual([action.type, action.by, action.cause], ['release-hold', 'engine', 'progress.finished']);
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('runner: no launchable agent is one board-level error listing the issues', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  try {
    const issue = (number) => ({
      number, body: '', labels: [],
      issue_field_values: [{ field_id: 1, single_select_option: { name: 'Ready' } }],
    });
    const result = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config: { ...loaded, launchRunners: [], engine: { logins: [ENGINE] } },
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => [1, 2].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } })),
        getIssue: async (number) => issue(number),
        listIssueComments: async () => [],
      },
    });
    assert.deepEqual(result.actions.map((entry) => entry.action.reason), ['ready.no-capable-agent', 'ready.no-capable-agent'], JSON.stringify(result.actions));
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /ready\.no-capable-agent.*#1, #2/);
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('#2554 replay: a hold set by two failed starts is released without a newer merge', () => {
  const comments = [launch(SHA, 480, 'failed=1'), launch(SHA, 100, 'failed=1')];
  const action = inMain(comments, { blocked: 'stalled' });
  assert.deepEqual([action.type, action.by, action.cause], ['release-hold', 'engine', 'aat.relaunch']);
});

test('a human retry restarts the quiet clock: an implementation fail does not re-stall at once', () => {
  const fail = comment(AGENT, `<!-- v2:aat verdict=fail reason=implementation merge=${SHA} -->`, 30 * 60);
  const comments = [launch(SHA, 31 * 60), fail];
  const base = {
    stage: 'In progress',
    delivery: { lastMergeSha: SHA, lastActivityAt: NOW - 30 * 60 * 60 * 1000, busy: false, openLinkedPrs: 0, dodComplete: true, mergedIntoMain: 1 },
    openFollowUps: 0,
  };
  assert.equal(inMain(comments, base).row, 'aat.implementation-quiet');
  const retried = inMain([...comments, release('human', 10)], base);
  assert.equal(retried.reason, 'aat.implementation-waiting');
});
