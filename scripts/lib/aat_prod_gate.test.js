'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMode, evaluateProdGate, renderSummary } = require('./aat_prod_gate');
const { collectCandidates } = require('./aat_prod_gate_collect');
const { runGate } = require('../ci/aat-prod-gate');

const M = 'a'.repeat(40);
const M2 = 'c'.repeat(40);
const P = 'b'.repeat(40);
const AGENT = 'pawpet-claude';
const ENGINE = 'pawpet-engine';
const CONFIG = {
  agents: [{ actsAs: AGENT }, { actsAs: 'pawpet-bot' }],
  engine: { logins: [ENGINE] },
  aat: { enabled: true, timeoutMin: 120, maxInconclusive: 2 },
};
const CONFIG_OFF = { ...CONFIG, aat: { ...CONFIG.aat, enabled: false } };

const ts = (n) => `2026-11-18T10:${String(n).padStart(2, '0')}:00Z`;
const comment = (id, login, body) => ({ id, user: { login }, body, created_at: ts(id) });
const launch = (id, merge = M) => comment(id, ENGINE, `engine\n<!-- v2:aat-launch merge=${merge} run=9 -->`);
const verdict = (id, value, extra = '', { merge = M, login = AGENT } = {}) =>
  comment(id, login, `done\n<!-- v2:aat verdict=${value}${extra} merge=${merge} -->`);
const waive = (id, kind, { merge = M } = {}) =>
  comment(id, ENGINE, `<!-- v2:aat-waive merge=${merge} acceptance=${kind} -->`);

// --- pure gate -------------------------------------------------------------

const candidate = (overrides) => ({ number: 1, stage: 'In UAT', mergeSha: M, satisfied: false, acceptance: 'Failed', ...overrides });

test('resolveMode: unset is off, known values pass, unknown is dry-run with a warning', () => {
  assert.deepEqual(resolveMode(''), { mode: 'off', warning: null });
  assert.deepEqual(resolveMode(undefined), { mode: 'off', warning: null });
  assert.equal(resolveMode('dry-run').mode, 'dry-run');
  assert.equal(resolveMode(' ON ').mode, 'on');
  const bogus = resolveMode('onn');
  assert.equal(bogus.mode, 'dry-run');
  assert.match(bogus.warning, /not off, dry-run or on/);
});

test('evaluateProdGate: dry-run lists what would block and never fails', () => {
  const result = evaluateProdGate({ mode: 'dry-run', candidates: [candidate({ number: 7 })] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.wouldBlock.map((item) => item.number), [7]);
});

test('evaluateProdGate: on fails on an unsatisfied candidate; satisfied ones pass', () => {
  const blocked = evaluateProdGate({ mode: 'on', candidates: [candidate({ number: 1 }), candidate({ number: 2, satisfied: true })] });
  assert.equal(blocked.pass, false);
  assert.deepEqual(blocked.blocking.map((item) => item.number), [1]);
  assert.equal(evaluateProdGate({ mode: 'on', candidates: [candidate({ satisfied: true })] }).pass, true);
  assert.equal(evaluateProdGate({ mode: 'on', candidates: [] }).pass, true);
});

test('evaluateProdGate: an override passes on and records what it overrode', () => {
  const result = evaluateProdGate({ mode: 'on', candidates: [candidate({ number: 9 })], overrideReason: 'owner waiver' });
  assert.equal(result.pass, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.overridden.map((item) => item.number), [9]);
  assert.equal(result.override, 'owner waiver');
});

test('renderSummary names the blocked issues and the result', () => {
  const result = evaluateProdGate({ mode: 'on', candidates: [candidate({ number: 12, stage: 'In progress' })] });
  const text = renderSummary({ mode: 'on', promotedSha: P, result });
  assert.match(text, /#12 \| In progress/);
  assert.match(text, /Result: \*\*blocked\*\*/);
});

// --- collector, using the engine's own acceptance rules ---------------------

const DEFS = [
  { id: 11, name: 'Stage', options: [] },
  { id: 12, name: 'Blocked', options: [] },
  { id: 13, name: 'Attempts', options: [] },
  { id: 14, name: 'Acceptance', options: [] },
  { id: 15, name: 'Acceptance fail reason', options: [] },
];

function issueFor(number, { stage = 'In UAT', acceptance = 'Pending', labels = [], body = '' } = {}) {
  const values = [{ field_id: 11, single_select_option: { name: stage } }];
  if (acceptance) values.push({ field_id: 14, single_select_option: { name: acceptance } });
  return { number, labels, body, issue_field_values: values };
}

const mergedPr = (mergeSha) => [{ merged: true, base: 'main', mergedAt: ts(0), updatedAt: ts(0), mergeSha }];

async function collect({ issues, prs = {}, comments = {}, contained = () => true, defs = DEFS, config = CONFIG, scopeLabel = '' }) {
  const calls = { n: 0 };
  const deps = {
    restFn: async (_method, path) => {
      calls.n += 1;
      if (path.startsWith('/orgs/')) return defs;
      const match = /\/issues\/(\d+)$/.exec(path);
      if (match) return issues[match[1]];
      throw new Error(`unexpected GET ${path}`);
    },
    listProjectIssues: async () =>
      Object.keys(issues).map((n) => ({ issue: { number: Number(n), repository: { name: 'r', owner: { login: 'o' } } } })),
    listLinkedPrs: async ({ issueNumber }) => prs[issueNumber] || [],
    fetchAllPages: async ({ path }) => comments[/issues\/(\d+)\//.exec(path)[1]] || [],
    promotedContains: async ({ mergeSha }) => contained(mergeSha),
  };
  const result = await collectCandidates({
    owner: 'o',
    repo: 'r',
    promotedSha: P,
    token: 't',
    projectId: 'p',
    statusFieldId: 's',
    scopeLabel,
    config,
    deps,
  });
  return { result, calls };
}

test('collector: aat.enabled false makes no API call and nothing can block', async () => {
  const { result, calls } = await collect({ issues: { 1: issueFor(1) }, prs: { 1: mergedPr(M) }, config: CONFIG_OFF });
  assert.deepEqual(result, { gateEnabled: false, candidates: [] });
  assert.equal(calls.n, 0);
});

test('collector: a missing "Acceptance fail reason" field disables the gate, as in the engine', async () => {
  const defs = DEFS.filter((def) => def.name !== 'Acceptance fail reason');
  const { result } = await collect({ issues: { 1: issueFor(1) }, prs: { 1: mergedPr(M) }, defs });
  assert.deepEqual(result, { gateEnabled: false, candidates: [] });
});

test('collector: an In UAT merge with a pass verdict from a listed agent after its launch is satisfied', async () => {
  const { result } = await collect({
    issues: { 1: issueFor(1, { stage: 'In UAT', acceptance: 'Passed' }) },
    prs: { 1: mergedPr(M) },
    comments: { 1: [launch(1), verdict(2, 'pass')] },
  });
  assert.equal(result.gateEnabled, true);
  assert.deepEqual(result.candidates, [{ number: 1, stage: 'In UAT', mergeSha: M, acceptance: 'Passed', satisfied: true }]);
});

test('collector: a bare Passed with no verdict is not satisfaction; a verdict before the launch is ignored', async () => {
  const { result } = await collect({
    issues: { 1: issueFor(1, { stage: 'In UAT', acceptance: 'Passed' }), 2: issueFor(2, { stage: 'In Main', acceptance: 'Pending' }) },
    prs: { 1: mergedPr(M), 2: mergedPr(M2) },
    comments: { 1: [], 2: [verdict(1, 'pass', '', { merge: M2 }), launch(2, M2)] },
    contained: () => true,
  });
  const byNumber = Object.fromEntries(result.candidates.map((c) => [c.number, c.satisfied]));
  assert.deepEqual(byNumber, { 1: false, 2: false });
});

test('collector: In progress is gated only when the newest actionable verdict for its merge is a scope or implementation fail', async () => {
  const { result } = await collect({
    issues: {
      1: issueFor(1, { stage: 'In progress', acceptance: 'Failed' }),
      2: issueFor(2, { stage: 'In progress', acceptance: 'Passed' }),
      3: issueFor(3, { stage: 'In progress', acceptance: 'Failed' }),
    },
    prs: { 1: mergedPr(M), 2: mergedPr(M), 3: mergedPr(M2) },
    comments: {
      1: [launch(1), verdict(2, 'fail', ' reason=scope')],
      2: [launch(1), verdict(2, 'fail', ' reason=quality')],
      3: [launch(1, M2), verdict(2, 'fail', ' reason=implementation', { merge: M2 })],
    },
  });
  assert.deepEqual(result.candidates.map((c) => [c.number, c.satisfied]), [[1, false], [3, false]]);
});

test('collector: an In Main quality fail is gated and not satisfied', async () => {
  const { result } = await collect({
    issues: { 1: issueFor(1, { stage: 'In Main', acceptance: 'Failed' }) },
    prs: { 1: mergedPr(M) },
    comments: { 1: [launch(1), verdict(2, 'fail', ' reason=quality')] },
  });
  assert.deepEqual(result.candidates.map((c) => [c.number, c.stage, c.satisfied]), [[1, 'In Main', false]]);
});

test('collector: a bound waiver satisfies Manual and Skipped, and a newer fail does not outrank it', async () => {
  const { result } = await collect({
    issues: {
      1: issueFor(1, { stage: 'In UAT', acceptance: 'Manual' }),
      2: issueFor(2, { stage: 'In UAT', acceptance: 'Skipped' }),
    },
    prs: { 1: mergedPr(M), 2: mergedPr(M) },
    comments: {
      1: [launch(1), verdict(2, 'fail', ' reason=quality'), waive(3, 'manual')],
      2: [waive(1, 'skipped')],
    },
  });
  assert.deepEqual(result.candidates.map((c) => [c.number, c.satisfied]), [[1, true], [2, true]]);
});

test('collector: follow-ups and manual-only issues are exempt, as in the engine', async () => {
  const { result } = await collect({
    issues: {
      1: issueFor(1, { stage: 'In UAT', acceptance: 'Pending', body: '<!-- v2:follow-up of=#9 -->\nbug' }),
      2: issueFor(2, { stage: 'In UAT', acceptance: 'Pending', labels: ['manual-only'] }),
      3: issueFor(3, { stage: 'In UAT', acceptance: 'Pending' }),
    },
    prs: { 1: mergedPr(M), 2: mergedPr(M), 3: mergedPr(M) },
  });
  assert.deepEqual(result.candidates.map((c) => c.number), [3]);
});

test('collector: merges not contained in the promoted SHA are out of scope', async () => {
  const { result } = await collect({
    issues: { 1: issueFor(1, { stage: 'In UAT', acceptance: 'Pending' }) },
    prs: { 1: mergedPr(M) },
    contained: () => false,
  });
  assert.deepEqual(result.candidates, []);
});

test('collector: the scope label limits the candidates', async () => {
  const { result } = await collect({
    issues: {
      1: issueFor(1, { stage: 'In UAT', labels: [{ name: 'pipeline-beta' }] }),
      2: issueFor(2, { stage: 'In UAT', labels: [] }),
    },
    prs: { 1: mergedPr(M), 2: mergedPr(M) },
    scopeLabel: 'pipeline-beta',
  });
  assert.deepEqual(result.candidates.map((c) => c.number), [1]);
});

// --- CLI exit policy ---------------------------------------------------------

const GATE_ENV = {
  GITHUB_REPOSITORY: 'o/r',
  AAT_GATE_READ_TOKEN: 't',
  GH_PROJECT_ID: 'p',
  GH_STATUS_FIELD_ID: 's',
  PROMOTED_SHA: P,
};
const quiet = () => {};
const blockingCollect = async () => ({ gateEnabled: true, candidates: [candidate({ number: 7 })] });
const brokenCollect = async () => {
  throw new Error('GitHub API 502');
};

test('runGate: AAT_GATE unset makes no API call and passes', async () => {
  let called = false;
  const out = await runGate({ env: { ...GATE_ENV }, collect: async () => { called = true; }, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(out.exitCode, 0);
  assert.equal(called, false);
});

test('runGate: aat.enabled false makes no API call even in on mode', async () => {
  let called = false;
  const out = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on' },
    collect: async () => { called = true; },
    loadConfigFn: () => CONFIG_OFF,
    log: quiet,
  });
  assert.equal(out.exitCode, 0);
  assert.equal(called, false);
});

test('runGate: on blocks with exit 1; dry-run reports the same list and exits 0', async () => {
  const on = await runGate({ env: { ...GATE_ENV, AAT_GATE: 'on' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(on.exitCode, 1);
  assert.match(on.summary, /#7/);
  const dry = await runGate({ env: { ...GATE_ENV, AAT_GATE: 'dry-run' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(dry.exitCode, 0);
  assert.match(dry.summary, /#7/);
});

test('runGate: on fails closed on an API error, and an authorised override lets it through', async () => {
  const closed = await runGate({ env: { ...GATE_ENV, AAT_GATE: 'on' }, collect: brokenCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(closed.exitCode, 1);
  assert.match(closed.summary, /GitHub API 502/);
  const overridden = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on', AAT_OVERRIDE_REASON: 'owner waiver', GITHUB_ACTOR: 'owner-login', AAT_OVERRIDE_ACTORS: 'other, owner-login' },
    collect: brokenCollect,
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  assert.equal(overridden.exitCode, 0);
  assert.match(overridden.summary, /authorised actor/);
});

test('runGate: an override from an actor not in AAT_OVERRIDE_ACTORS is ignored, and an empty list allows none', async () => {
  const notListed = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on', AAT_OVERRIDE_REASON: 'ship it', GITHUB_ACTOR: 'someone', AAT_OVERRIDE_ACTORS: 'owner-login' },
    collect: blockingCollect,
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  assert.equal(notListed.exitCode, 1);
  assert.match(notListed.summary, /Override ignored: someone is not in AAT_OVERRIDE_ACTORS/);
  const emptyList = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on', AAT_OVERRIDE_REASON: 'ship it', GITHUB_ACTOR: 'someone' },
    collect: blockingCollect,
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  assert.equal(emptyList.exitCode, 1);
});

test('runGate: the read token is required; GITHUB_TOKEN is not used as a fallback', async () => {
  const env = { ...GATE_ENV, AAT_GATE: 'on' };
  delete env.AAT_GATE_READ_TOKEN;
  const out = await runGate({ env: { ...env, GITHUB_TOKEN: 'ghs_workflow' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(out.exitCode, 1);
  assert.match(out.summary, /AAT_GATE_READ_TOKEN are required/);
});

test('runGate: with aat.enabled false nothing is required, even in on mode with no token or project IDs', async () => {
  let called = false;
  const out = await runGate({
    env: { AAT_GATE: 'on', PROMOTED_SHA: 'main' },
    collect: async () => { called = true; },
    loadConfigFn: () => CONFIG_OFF,
    log: quiet,
  });
  assert.equal(out.exitCode, 0);
  assert.equal(called, false);
});

test('runGate: summary and log text is plain (no newlines, no workflow commands from user-supplied text)', async () => {
  const out = await runGate({
    env: {
      ...GATE_ENV,
      AAT_GATE: 'dry-run',
      AAT_OVERRIDE_REASON: 'x\n::set-output name=evil::1 | <b>',
      GITHUB_ACTOR: 'owner-login',
      AAT_OVERRIDE_ACTORS: 'owner-login',
    },
    collect: blockingCollect,
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  // The summary is a markdown file, not stdout, so workflow commands only matter on log lines. The
  // override note must be one line with the user text reduced to safe characters.
  const overrideLine = out.summary.split('\n').find((line) => line.includes('Override recorded'));
  assert.ok(overrideLine);
  assert.doesNotMatch(overrideLine, /[<>|]/);
  assert.match(overrideLine, /set-output name=evil/);
});

test('runGate: dry-run never fails on an error, and a bad SHA fails only in on', async () => {
  const dry = await runGate({ env: { ...GATE_ENV, AAT_GATE: 'dry-run' }, collect: brokenCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(dry.exitCode, 0);
  const badSha = { ...GATE_ENV, PROMOTED_SHA: 'main' };
  assert.equal((await runGate({ env: { ...badSha, AAT_GATE: 'on' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet })).exitCode, 1);
  assert.equal((await runGate({ env: { ...badSha, AAT_GATE: 'dry-run' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet })).exitCode, 0);
});

test('runGate: missing acceptance fields pass in on mode with a note', async () => {
  const out = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on' },
    collect: async () => ({ gateEnabled: false, candidates: [] }),
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  assert.equal(out.exitCode, 0);
  assert.match(out.summary, /gate is disabled/);
});
