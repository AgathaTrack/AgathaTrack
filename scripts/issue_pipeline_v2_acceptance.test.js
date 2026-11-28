'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { buildIssueFieldPatch, withCurrentValues } = require('./issue_pipeline_v2_fields');
const { launchIssue } = require('./issue_pipeline_v2_launch');
const { deriveAatState } = require('./issue_pipeline_v2_acceptance');
const { tick } = require('./issue_pipeline_v2');

const loaded = loadConfig();
const config = { ...loaded, aat: { enabled: true, timeoutMin: 120, maxInconclusive: 2 } };
const both = { ...config, launchRunners: ['cursor', 'claude'] };
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const NOW = Date.parse('2026-11-16T12:00:00Z');
const ENGINE = 'pawpet-engine';
const AGENT = 'pawpet-bot';
const OTHER = 'pawpet-claude';
let seq = 1;

function at(minutesAgo) {
  return new Date(NOW - minutesAgo * 60 * 1000).toISOString();
}

function comment(login, body, minutesAgo) {
  const created_at = at(minutesAgo);
  seq += 1;
  return { id: seq, user: { login }, created_at, updated_at: created_at, body };
}

function aat(comments) {
  return deriveAatState({ comments, engineLogins: [ENGINE], agentLogins: [AGENT, OTHER] });
}

function gate(over = {}, cfg = config) {
  return decide({
    mode: 'dry-run',
    now: NOW,
    onBoard: true,
    labels: [],
    stage: 'In Main',
    blocked: '',
    bodyHash: 'h',
    wip: 0,
    aatFieldsPresent: true,
    isFollowUp: false,
    acceptance: '',
    acceptanceFailReason: '',
    delivery: { lastMergeSha: SHA, lastActivityAt: NOW - 60 * 1000, busy: false, openLinkedPrs: 0 },
    deliveryMethod: 'light-plan',
    ...over,
    aat: over.comments ? aat(over.comments) : over.aat,
  }, cfg);
}

const launch = (sha = SHA, minutesAgo = 1, extra = 'run=r1') =>
  comment(ENGINE, `<!-- v2:aat-launch merge=${sha} ${extra} -->`, minutesAgo);
const verdict = (body, minutesAgo = 0, login = AGENT) => comment(login, body, minutesAgo);
const pass = (sha = SHA, minutesAgo = 0) =>
  verdict(`<!-- v2:aat verdict=pass merge=${sha} -->`, minutesAgo);
const fail = (reason, sha = SHA, minutesAgo = 0) =>
  verdict(`<!-- v2:aat verdict=fail reason=${reason} merge=${sha} -->`, minutesAgo);

const done = {
  busy: false,
  dodComplete: true,
  openLinkedPrs: 0,
  mergedIntoMain: 1,
  lastMergeSha: SHA,
  lastActivityAt: NOW,
};

test('flag off: In Main still requests intent review then UAT', () => {
  const off = { ...loaded, aat: { ...loaded.aat, enabled: false } };
  const request = decide({
    mode: 'dry-run', now: NOW, onBoard: true, labels: [], stage: 'In Main', blocked: '',
    delivery: { lastMergeSha: SHA }, prAuthors: [AGENT],
  }, { ...off, launchRunners: ['cursor', 'claude'] });
  assert.equal(request.type, 'request-intent-review');
  const finished = decide({
    mode: 'dry-run', now: NOW, onBoard: true, labels: [], stage: 'In progress', blocked: '',
    delivery: done,
  }, off);
  assert.deepEqual(finished.then, ['request-intent-review']);
});

test('flag on: no intent review for a non-follow-up; a follow-up still requests it', () => {
  const launched = gate({ comments: [] });
  assert.equal(launched.type, 'launch-aat');
  assert.notEqual(launched.type, 'request-intent-review');
  const follow = gate({
    isFollowUp: true,
    intentReview: { requested: false },
    prAuthors: [AGENT],
    comments: [],
  }, both);
  assert.equal(follow.type, 'request-intent-review');
  const finished = gate({ stage: 'In progress', delivery: done, comments: [] });
  assert.equal(finished.then, undefined);
  const followFinished = gate({ stage: 'In progress', delivery: done, isFollowUp: true, comments: [] });
  assert.deepEqual(followFinished.then, ['request-intent-review']);
});

test('dual gate: pass without UAT stays, UAT without pass stays, both move', () => {
  const passed = gate({ comments: [launch(), pass()], uatContainsLatestMerge: false });
  assert.equal(passed.reason, 'aat.waiting-uat');
  assert.equal(passed.acceptance, 'Passed');
  assert.equal(passed.acceptanceFailReason, null);
  const bare = gate({ comments: [launch()], uatContainsLatestMerge: true });
  assert.equal(bare.reason, 'aat.waiting-verdict');
  assert.notEqual(bare.to, 'In UAT');
  const bothReady = gate({ comments: [launch(), pass()], uatContainsLatestMerge: true });
  assert.equal(bothReady.to, 'In UAT');
  assert.equal(bothReady.acceptance, 'Passed');
});

test('each fail reason rewinds or stays, and does not bounce back to In Main', () => {
  for (const reason of ['scope', 'implementation']) {
    const action = gate({ comments: [launch(), fail(reason)], uatContainsLatestMerge: true });
    assert.equal(action.to, 'In progress', reason);
    assert.equal(action.acceptanceFailReason, reason);
    assert.notEqual(action.row, 'ready.launched');
    const held = gate({
      stage: 'In progress',
      comments: [launch(), fail(reason)],
      delivery: { ...done, busy: true, lastActivityAt: NOW },
    });
    assert.notEqual(held.to, 'In Main', reason);
    assert.notEqual(held.type, 'resume', reason);
  }
  const quality = gate({ comments: [launch(), fail('quality')], uatContainsLatestMerge: true });
  assert.equal(quality.reason, 'aat.quality');
  assert.equal(quality.acceptance, 'Failed');
  assert.equal(quality.acceptanceFailReason, 'quality');
  assert.notEqual(quality.to, 'In UAT');
});

test('scope relaunches once; implementation does not relaunch the parent', () => {
  const quiet = NOW - 25 * 60 * 60 * 1000;
  const relaunch = gate({
    stage: 'In progress',
    comments: [launch(), fail('scope')],
    delivery: { ...done, busy: false, lastActivityAt: quiet, openLinkedPrs: 0 },
  });
  assert.equal(relaunch.type, 'aat-relaunch');
  assert.equal(relaunch.method, 'light-plan');
  const again = gate({
    stage: 'In progress',
    comments: [
      launch(),
      fail('scope'),
      comment(ENGINE, `<!-- v2:aat-relaunch merge=${SHA} reason=scope -->`, 10),
    ],
    delivery: { ...done, busy: false, lastActivityAt: NOW, openLinkedPrs: 0 },
  });
  assert.equal(again.reason, 'aat.scope-waiting');
  const impl = gate({
    stage: 'In progress',
    comments: [launch(SHA, 40), fail('implementation', SHA, 10)],
    delivery: { ...done, busy: false, openLinkedPrs: 0 },
    openFollowUps: 0,
  });
  assert.notEqual(impl.type, 'aat-relaunch');
  assert.equal(impl.reason, 'aat.implementation-waiting');
});

test('an in-flight launch is not relaunched; inconclusive and timeout share one cap', () => {
  const inflight = gate({ comments: [launch(SHA, 10)] });
  assert.equal(inflight.reason, 'aat.waiting-verdict');
  const once = gate({ comments: [launch(SHA, 121), verdict(`<!-- v2:aat verdict=inconclusive merge=${SHA} -->`, 100)] });
  assert.equal(once.type, 'launch-aat');
  assert.equal(once.row, 'aat.relaunch');
  const second = gate({
    comments: [
      launch(SHA, 400),
      verdict(`<!-- v2:aat verdict=inconclusive merge=${SHA} -->`, 300),
      launch(SHA, 200, 'run=r2'),
    ],
  });
  assert.equal(second.reason, 'stalled');
  assert.equal(second.row, 'aat.inconclusive-cap');
  const sameLaunch = gate({
    comments: [
      launch(SHA, 200),
      verdict(`<!-- v2:aat verdict=inconclusive merge=${SHA} -->`, 10),
    ],
  });
  assert.equal(sameLaunch.type, 'launch-aat', 'timeout plus a later inconclusive on the same launch is one attempt');
});

test('a launch that failed to start uses the backoff, not the attempt budget (#2554)', () => {
  // Backoff 5, 30, 120 minutes: a failed start waits, then is retried.
  assert.equal(gate({ comments: [launch(SHA, 1, 'failed=1')] }).reason, 'aat.backoff');
  assert.equal(gate({ comments: [launch(SHA, 6, 'failed=1')] }).type, 'launch-aat');
  // #2554: two failed starts are not two concluded attempts.
  const twice = gate({ comments: [launch(SHA, 400, 'failed=1'), launch(SHA, 40, 'failed=1')] });
  assert.equal(twice.type, 'launch-aat');
  assert.notEqual(twice.reason, 'stalled');
  // One inconclusive run, then a failed relaunch: still one attempt used, so it relaunches.
  const mixed = gate({
    comments: [launch(SHA, 400), verdict(`<!-- v2:aat verdict=inconclusive merge=${SHA} -->`, 300), launch(SHA, 200, 'failed=1')],
  });
  assert.equal(mixed.type, 'launch-aat');
  // Past the backoff list the issue gets the engine hold launch-failed.
  const exhausted = gate({
    comments: [400, 300, 200, 10].map((ago) => launch(SHA, ago, 'failed=1')),
  });
  assert.deepEqual([exhausted.type, exhausted.reason, exhausted.row], ['set-blocked', 'launch-failed', 'aat.launch-failed']);
});

test('reset, waive, and bare Passed', () => {
  const reset = gate({
    acceptance: 'Passed',
    comments: [launch(SHA2, 30), pass(SHA2, 20)],
    delivery: { lastMergeSha: SHA },
  });
  assert.equal(reset.type, 'aat-reset');
  assert.equal(reset.acceptance, 'Pending');
  assert.equal(reset.acceptanceFailReason, null);
  const skipped = gate({
    acceptance: 'Skipped',
    comments: [comment(ENGINE, `<!-- v2:aat-waive merge=${SHA2} acceptance=skipped -->`, 20)],
  });
  assert.equal(skipped.type, 'aat-waive');
  assert.equal(skipped.acceptance, 'skipped');
  assert.notEqual(skipped.type, 'aat-reset');
  assert.notEqual(skipped.type, 'launch-aat');
  const oldManual = gate({
    acceptance: 'Manual',
    comments: [comment(ENGINE, `<!-- v2:aat-waive merge=${SHA2} acceptance=manual -->`, 20)],
  });
  assert.equal(oldManual.type, 'aat-reset');
  const freshManual = gate({ acceptance: 'Manual', comments: [] });
  assert.equal(freshManual.type, 'aat-waive');
  assert.equal(freshManual.acceptance, 'manual');
  const afterReset = gate({
    acceptance: 'Manual',
    comments: [
      comment(ENGINE, `<!-- v2:aat-waive merge=${SHA2} acceptance=manual -->`, 40),
      comment(ENGINE, `<!-- v2:aat-reset merge=${SHA} -->`, 10),
    ],
  });
  assert.equal(afterReset.type, 'aat-waive');
  const bound = gate({
    acceptance: 'Manual',
    uatContainsLatestMerge: true,
    comments: [
      comment(ENGINE, `<!-- v2:aat-reset merge=${SHA} -->`, 30),
      comment(ENGINE, `<!-- v2:aat-waive merge=${SHA} acceptance=manual -->`, 10),
      launch(SHA, 20),
      fail('quality', SHA, 5),
    ],
  });
  assert.equal(bound.to, 'In UAT');
  assert.equal(bound.acceptance, undefined, 'a bound Manual is not overwritten');
  const skippedBound = gate({
    acceptance: 'Skipped',
    comments: [
      launch(),
      pass(),
      comment(ENGINE, `<!-- v2:aat-waive merge=${SHA} acceptance=skipped -->`, 5),
    ],
  });
  assert.equal(skippedBound.reason, 'aat.waiting-uat');
  assert.equal(skippedBound.acceptance, undefined);
  const bare = gate({ acceptance: 'Passed', uatContainsLatestMerge: true, comments: [] });
  assert.equal(bare.type, 'launch-aat');
  assert.equal(bare.acceptance, 'Pending');
  assert.notEqual(bare.to, 'In UAT');
});

test('ignored markers and a newer actionable verdict', () => {
  const early = gate({
    uatContainsLatestMerge: true,
    comments: [pass(SHA, 30), launch(SHA, 10)],
  });
  assert.notEqual(early.to, 'In UAT');
  const stranger = gate({
    uatContainsLatestMerge: true,
    comments: [launch(), verdict(`<!-- v2:aat verdict=pass merge=${SHA} -->`, 0, 'KanopeeKa')],
  });
  assert.notEqual(stranger.to, 'In UAT');
  const noReason = gate({
    comments: [launch(), verdict(`<!-- v2:aat verdict=fail merge=${SHA} -->`, 0)],
  });
  assert.notEqual(noReason.to, 'In progress');
  const ordered = gate({
    comments: [
      launch(SHA, 20),
      verdict(`<!-- v2:aat merge=${SHA} verdict=pass -->`, 10),
      verdict(`<!-- v2:aat merge=${SHA} reason=implementation verdict=fail -->`, 1),
    ],
  });
  assert.equal(ordered.acceptanceFailReason, 'implementation');
  const newerPass = gate({
    uatContainsLatestMerge: true,
    acceptance: 'Failed',
    comments: [launch(SHA, 20), fail('quality', SHA, 10), pass(SHA, 1)],
  });
  assert.equal(newerPass.to, 'In UAT');
  assert.equal(newerPass.acceptance, 'Passed');
});

test('a follow-up keeps today\'s In Main rows; manual-only never reaches them', () => {
  const follow = gate({
    isFollowUp: true,
    intentReview: { requested: true },
    uatContainsLatestMerge: true,
    comments: [],
  });
  assert.equal(follow.to, 'In UAT');
  const manual = gate({ labels: ['manual-only'], comments: [launch(), pass()], uatContainsLatestMerge: true });
  assert.equal(manual.reason, 'manual-only');
});

test('no startable agent is a board-level error and does not enter In UAT', () => {
  const action = gate({ comments: [], uatContainsLatestMerge: true }, { ...config, launchRunners: [] });
  assert.deepEqual([action.type, action.reason, action.boardError], ['none', 'aat.no-launchable-agent', true]);
  assert.notEqual(action.to, 'In UAT');
});

test('implementation follow-up, parent Refs, and search errors', () => {
  const waiting = gate({
    stage: 'In progress',
    comments: [launch(), fail('implementation')],
    delivery: { ...done, openLinkedPrs: 1, busy: false },
    openFollowUps: 1,
  });
  assert.equal(waiting.reason, 'aat.implementation-waiting');
  const openPr = gate({
    stage: 'In progress',
    comments: [launch(SHA, 30 * 60), fail('implementation', SHA, 24 * 60 + 5)],
    delivery: { ...done, openLinkedPrs: 1 },
    openFollowUps: 0,
  });
  assert.equal(openPr.reason, 'aat.implementation-waiting');
  const released = gate({
    stage: 'In progress',
    comments: [launch(SHA2, 40), fail('implementation', SHA2, 30)],
    delivery: { ...done, lastMergeSha: SHA },
  });
  assert.equal(released.to, 'In Main');
  const search = gate({
    stage: 'In progress',
    implementationSearchError: true,
    comments: [launch(SHA, 30 * 60), fail('implementation', SHA, 24 * 60 + 5)],
    delivery: done,
  });
  assert.equal(search.reason, 'aat.implementation-search-error');
  assert.notEqual(search.reason, 'stalled');
  assert.notEqual(search.to, 'In Main');
  const quiet = gate({
    stage: 'In progress',
    comments: [launch(SHA, 30 * 60), fail('implementation', SHA, 24 * 60 + 5)],
    delivery: done,
    openFollowUps: 0,
  });
  assert.equal(quiet.row, 'aat.implementation-quiet');
});

test('scope does not stall on a dropped busy label, an open PR, or a quiet late relaunch; failed=1 backs off', () => {
  const dropped = gate({
    stage: 'In progress',
    comments: [launch(), fail('scope'), comment(ENGINE, `<!-- v2:aat-relaunch merge=${SHA} reason=scope -->`, 5)],
    delivery: { ...done, busy: false, lastActivityAt: NOW, openLinkedPrs: 0 },
  });
  assert.equal(dropped.reason, 'aat.scope-waiting');
  const open = gate({
    stage: 'In progress',
    comments: [launch(), fail('scope')],
    delivery: { ...done, busy: false, openLinkedPrs: 1, lastActivityAt: NOW - 48 * 60 * 60 * 1000 },
  });
  assert.equal(open.reason, 'aat.scope-waiting');
  const late = gate({
    stage: 'In progress',
    comments: [launch(), fail('scope')],
    delivery: { ...done, busy: false, openLinkedPrs: 0, lastActivityAt: NOW - 48 * 60 * 60 * 1000 },
  });
  assert.equal(late.type, 'aat-relaunch');
  const relaunchFailed = (ago) => comment(ENGINE, `<!-- v2:aat-relaunch merge=${SHA} reason=scope failed=1 -->`, ago);
  const scopeHold = (extra) => gate({
    stage: 'In progress',
    comments: [launch(SHA, 500), fail('scope', SHA, 490), ...extra],
    delivery: { ...done, busy: false, openLinkedPrs: 0, lastActivityAt: NOW },
  });
  assert.equal(scopeHold([relaunchFailed(1)]).reason, 'aat.scope-backoff');
  assert.equal(scopeHold([relaunchFailed(6)]).type, 'aat-relaunch');
  const blown = scopeHold([400, 300, 200, 10].map(relaunchFailed));
  assert.deepEqual([blown.type, blown.reason, blown.row], ['set-blocked', 'launch-failed', 'aat.scope-relaunch-failed']);
});

test('prefer an agent who did not author the merged PRs', () => {
  const action = gate({ comments: [], prAuthors: [AGENT] }, both);
  assert.equal(action.agent, 'claude-a');
});

test('a null fail reason is omitted and not copied back; a later block still carries Acceptance', () => {
  const fields = {
    stage: { id: 1, name: 'Stage', options: ['In Main', 'In progress'] },
    blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
    attempts: { id: 3, name: 'Attempts', options: [] },
    acceptance: { id: 4, name: 'Acceptance', options: ['Pending', 'Passed', 'Failed', 'Manual', 'Skipped'] },
    acceptanceFailReason: { id: 5, name: 'Acceptance fail reason', options: ['scope', 'implementation', 'quality'] },
  };
  const parsed = { stage: 'In Main', blocked: '', attempts: 2, acceptance: 'Failed', acceptanceFailReason: 'scope' };
  const merged = withCurrentValues(parsed, { acceptance: 'Pending', acceptanceFailReason: null });
  assert.equal(merged.acceptance, 'Pending');
  assert.equal('acceptanceFailReason' in merged, false);
  assert.equal(merged.stage, 'In Main');
  const patch = buildIssueFieldPatch(fields, { acceptance: 'Pending', acceptanceFailReason: null }, parsed);
  assert.equal(patch.some((entry) => entry.field_id === 5), false);
  assert.equal(patch.find((entry) => entry.field_id === 4).value, 'Pending');
  const carried = buildIssueFieldPatch(fields, { blocked: 'stalled' }, parsed);
  assert.equal(carried.find((entry) => entry.field_id === 4).value, 'Failed');
  assert.equal(carried.find((entry) => entry.field_id === 5).value, 'scope');
});

test('apply: thrown acceptance launch posts failed=1 and a rewind does not ack', async () => {
  const fields = {
    stage: { id: 1, name: 'Stage', options: ['In Main', 'In progress', 'In UAT'] },
    blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
    attempts: { id: 3, name: 'Attempts', options: [] },
    acceptance: { id: 4, name: 'Acceptance', options: ['Pending', 'Passed', 'Failed', 'Manual', 'Skipped'] },
    acceptanceFailReason: { id: 5, name: 'Acceptance fail reason', options: ['scope', 'implementation', 'quality'] },
  };
  const sent = [];
  const restFn = async (method, path, token, body) => {
    sent.push({ method, path, body });
    return { id: 1, issue_field_values: [] };
  };
  const ctx = {
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config, fields,
    parsed: { stage: 'In Main', attempts: 1, acceptance: 'Passed', acceptanceFailReason: '' },
    assignees: [], facts: { launch: { runId: 'r9' }, delivery: { lastMergeSha: SHA } }, dryRun: false, restFn,
  };
  const failed = await applyAction({
    action: { type: 'launch-aat', agent: AGENT, mergeSha: SHA, row: 'aat.launch', acceptance: 'Pending', acceptanceFailReason: null },
    ctx: { ...ctx, launchFn: async () => { throw new Error('down'); } },
  });
  assert.equal(failed.applied[0], `aat-launch-failed:${AGENT}`);
  assert.equal(failed.applied.some((entry) => entry.startsWith('launch:')), false);
  assert.match(sent[0].body.body, /v2:aat-launch merge=a{40} failed=1 agent=pawpet-bot/);
  assert.equal(sent.some((call) => call.body?.issue_field_values), false);
  sent.length = 0;
  const rewind = await applyAction({
    action: { type: 'set-stage', to: 'In progress', row: 'aat.fail-scope', acceptance: 'Failed', acceptanceFailReason: 'scope' },
    ctx,
  });
  assert.equal(sent.some((call) => /v2:launch-acked/.test(call.body?.body || '')), false);
  assert.equal(rewind.applied.includes('comment:launch-acked'), false);
  sent.length = 0;
  const started = await applyAction({
    action: { type: 'launch-aat', agent: AGENT, mergeSha: SHA, row: 'aat.launch', acceptance: 'Pending', acceptanceFailReason: null },
    ctx: { ...ctx, launchFn: async (args) => { assert.equal(args.stage, 'acceptance'); assert.equal(args.mergeSha, SHA); return { runId: 'run-1' }; } },
  });
  assert.equal(started.applied[0], `aat-launch:${AGENT}`);
  const launchComment = sent.find((call) => /v2:aat-launch/.test(call.body?.body || ''));
  assert.match(launchComment.body.body, /agent=pawpet-bot/);
  const patch = sent.find((call) => call.body?.issue_field_values);
  assert.ok(sent.indexOf(launchComment) < sent.indexOf(patch));
  const stateMarker = sent.find((call) => /v2:aat-state/.test(call.body?.body || ''));
  assert.ok(stateMarker, 'acceptance field write posts v2:aat-state');
});

test('acceptance launch prompt names the skill, the issue and the sha', async () => {
  const { launch: cursorLaunch } = require('./pipeline_runners/cursor');
  const launches = [];
  const issue = { number: 2448, title: 't', body: 'b', labels: [{ name: 'blocked' }] };
  const agent = { id: 'cursor-a', actsAs: 'pawpet-bot', runner: 'cursor', model: 'composer-2.5' };
  await cursorLaunch({
    agent, issue, owner: 'o', repo: 'r', stage: 'acceptance', method: 'PR', nonce: 'ab', runSecret: 'cd',
    purpose: 'doorbell', apiKey: 'k', config: loaded, mergeSha: SHA,
    deps: {
      payload: { buildAgentPayload: () => ({}), buildAgentPrompt: () => 'base' },
      launcher: async ({ promptText }) => { launches.push(promptText); return { run: { id: 'r' }, agent: { url: 'u' } }; },
    },
  });
  assert.match(launches[0], /agent-acceptance\/SKILL\.md/);
  assert.match(launches[0], /#2448/);
  assert.match(launches[0], new RegExp(SHA));
  assert.match(launches[0], /--reason/);
  assert.doesNotMatch(launches[0], /INTENT REVIEW/);
  launches.length = 0;
  const labels = [];
  await launchIssue({
    owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', agent: 'cursor-a', config: loaded,
    method: 'light-plan', scopeRelaunchSha: SHA,
    deps: {
      safety: { preflightIssue: () => ({ ok: true }) },
      lib: { setLabels: async (o, r, n, add) => labels.push(add) },
      runners: {
        cursor: {
          launch: async (args) => {
            launches.push(args.scopeRelaunchSha);
            return { runId: 'r' };
          },
        },
      },
    },
  });
  assert.deepEqual(labels[0], ['busy']);
  assert.equal(launches[0], SHA);
});

test('a missing acceptance field logs once and keeps intent review; an empty value does not', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  const logs = [];
  const orig = console.log;
  console.log = (line) => logs.push(line);
  const sha = SHA;
  const issue = (number) => ({
    number,
    body: '### Delivery plan\n\nMethod: PR\n',
    labels: [],
    assignees: [],
    issue_field_values: [{ field_id: 1, single_select_option: { name: 'In Main' } }],
  });
  const io = {
    config,
    umbrellaRollup: async () => ({ children: [], blockers: [] }), // no sub-issues: no network read
    fields: {
      stage: { id: 1, name: 'Stage', options: ['In Main'] },
      blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
      attempts: { id: 3, name: 'Attempts', options: [] },
    },
    listProjectIssues: async () => [9, 10].map((number) => ({
      issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } },
    })),
    getIssue: async (number) => issue(number),
    listIssueComments: async () => [],
    listLinkedPrs: async () => [{
      number: 1, state: 'closed', merged: true, mergedAt: '2026-11-01T00:00:00Z', mergeSha: sha,
      base: 'main', author: AGENT, updatedAt: '2026-11-01T00:00:00Z',
    }],
    deploySha: async () => null,
    deployContains: async () => false,
  };
  try {
    const missing = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', io,
    });
    const events = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'acceptance.field-missing');
    assert.equal(events.length, 1);
    assert.equal(missing.actions.every((entry) => entry.action.type === 'request-intent-review'), true);
    logs.length = 0;
    io.fields = {
      ...io.fields,
      acceptance: { id: 4, name: 'Acceptance', options: ['Pending', 'Passed', 'Failed', 'Manual', 'Skipped'] },
      acceptanceFailReason: { id: 5, name: 'Acceptance fail reason', options: ['scope', 'implementation', 'quality'] },
    };
    io.listProjectIssues = async () => [{
      issue: { number: 9, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } },
    }];
    const empty = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', io,
    });
    assert.equal(logs.map((line) => JSON.parse(line)).some((entry) => entry.event === 'acceptance.field-missing'), false);
    assert.equal(empty.actions[0].action.type, 'launch-aat');
  } finally {
    console.log = orig;
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

const AAT_FIELDS = {
  stage: { id: 1, name: 'Stage', options: ['In Main', 'In progress', 'In UAT'] },
  blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
  attempts: { id: 3, name: 'Attempts', options: [] },
  acceptance: { id: 4, name: 'Acceptance', options: ['Pending', 'Passed', 'Failed', 'Manual', 'Skipped'] },
  acceptanceFailReason: { id: 5, name: 'Acceptance fail reason', options: ['scope', 'implementation', 'quality'] },
};

function aatCtx(restFn, extra = {}) {
  return {
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config: both, fields: AAT_FIELDS,
    parsed: { stage: 'In Main', attempts: 1, acceptance: 'Pending', acceptanceFailReason: '' },
    assignees: [], facts: { launch: { runId: 'r9' }, delivery: { lastMergeSha: SHA } }, dryRun: false, restFn,
    ...extra,
  };
}

test('apply: a Claude AAT launch dispatches the claude run with a nonce', async () => {
  const claudeRunner = require('./pipeline_runners/claude');
  const dispatches = [];
  const restFn = async (method, path, token, body) => {
    if (path.includes('/runs?')) return { workflow_runs: [] };
    if (path.includes('/dispatches')) dispatches.push(body);
    return { id: 1, issue_field_values: [] };
  };
  const launchFn = async (args) => launchIssue({
    ...args,
    owner: 'o', repo: 'r', issue: { number: 7, labels: [], title: 't', body: 'b' }, token: 'pat', config: both,
    deps: { lib: { setLabels: async () => {} }, runners: { claude: claudeRunner }, restFn },
  });
  const result = await applyAction({
    action: { type: 'launch-aat', agent: 'claude-a', mergeSha: SHA, row: 'aat.launch', acceptance: 'Pending', acceptanceFailReason: null },
    ctx: aatCtx(restFn, { launchFn }),
  });
  assert.equal(result.applied[0], 'aat-launch:claude-a');
  assert.equal(dispatches.length, 1, 'one workflow dispatch for the claude run');
  assert.match(dispatches[0].inputs.nonce, /^[0-9a-f]{32}$/);
  assert.equal(dispatches[0].inputs.agent_id, 'claude-a');
});

test('apply: a failed acceptance launch names the reason and never posts the nonce', async () => {
  const sent = [];
  const restFn = async (method, path, token, body) => {
    sent.push({ method, path, body });
    return { id: 1, issue_field_values: [] };
  };
  let nonceSeen = null;
  const result = await applyAction({
    action: { type: 'launch-aat', agent: 'claude-a', mergeSha: SHA, row: 'aat.launch', acceptance: 'Pending', acceptanceFailReason: null },
    ctx: aatCtx(restFn, {
      launchFn: async ({ nonce }) => {
        nonceSeen = nonce;
        throw new Error(`claude launch refused for ${nonce}`);
      },
    }),
  });
  assert.equal(result.applied[0], 'aat-launch-failed:claude-a');
  const body = sent[0].body.body;
  assert.match(body, /v2:aat-launch merge=a{40} failed=1 agent=claude-a/);
  assert.match(body, /Starting acceptance failed: claude launch refused for \[redacted\]\./);
  assert.ok(nonceSeen && !body.includes(nonceSeen), 'the nonce stays secret until the run verdict');
});
