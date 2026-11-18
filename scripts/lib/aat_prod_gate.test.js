'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAatMarker, deriveAatFacts, aatSatisfied } = require('./aat_satisfied');
const { resolveMode, evaluateProdGate, renderSummary } = require('./aat_prod_gate');
const { collectCandidates } = require('./aat_prod_gate_collect');
const { runGate } = require('../ci/aat-prod-gate');

const M = 'a'.repeat(40);
const M2 = 'c'.repeat(40);
const P = 'b'.repeat(40);
const AGENT = 'pawpet-claude';
const ENGINE = 'pawpet-engine';
const CONFIG = { agents: [{ actsAs: AGENT }, { actsAs: 'pawpet-bot' }], engine: { logins: [ENGINE] } };

const comment = (id, login, body) => ({ id, user: { login }, body, created_at: `2026-11-18T10:0${id}:00Z` });
const launch = (id, merge = M) => comment(id, ENGINE, `engine\n<!-- v2:aat-launch merge=${merge} run=99 -->`);
const verdict = (id, value, extra = '', { merge = M, login = AGENT } = {}) =>
  comment(id, login, `done\n<!-- v2:aat verdict=${value}${extra} merge=${merge} -->`);
const waive = (id, kind, { merge = M, login = ENGINE } = {}) =>
  comment(id, login, `<!-- v2:aat-waive merge=${merge} acceptance=${kind} -->`);

test('resolveMode: unset is off, known values pass, unknown is dry-run with a warning', () => {
  assert.deepEqual(resolveMode(''), { mode: 'off', warning: null });
  assert.deepEqual(resolveMode(undefined), { mode: 'off', warning: null });
  assert.equal(resolveMode('dry-run').mode, 'dry-run');
  assert.equal(resolveMode(' ON ').mode, 'on');
  const bogus = resolveMode('onn');
  assert.equal(bogus.mode, 'dry-run');
  assert.match(bogus.warning, /not off, dry-run or on/);
});

test('parseAatMarker reads the last line and ignores markers this guard does not use', () => {
  assert.deepEqual(parseAatMarker(`text\n<!-- v2:aat verdict=fail reason=scope merge=${M} -->`).attrs, {
    verdict: 'fail',
    reason: 'scope',
    merge: M,
  });
  assert.equal(parseAatMarker(`<!-- v2:aat verdict=pass merge=${M} -->\nlater text`), null);
  assert.equal(parseAatMarker(`<!-- v2:aat-reset merge=${M} -->`), null);
  assert.equal(parseAatMarker(`<!-- v2:aat-bypassed -->`), null);
  assert.equal(parseAatMarker('plain comment'), null);
});

test('deriveAatFacts: a listed agent verdict after the engine launch for the same sha counts', () => {
  const facts = deriveAatFacts({ comments: [launch(1), verdict(2, 'pass')], mergeSha: M, listedAgents: [AGENT], engineLogins: [ENGINE] });
  assert.deepEqual(facts.verdict, { verdict: 'pass', reason: null });
});

test('deriveAatFacts: verdicts before the launch, unlisted authors and other shas do not count', () => {
  const engineLogins = [ENGINE];
  const listedAgents = [AGENT];
  const before = deriveAatFacts({ comments: [verdict(1, 'pass'), launch(2)], mergeSha: M, listedAgents, engineLogins });
  assert.equal(before.verdict, null);
  const unlisted = deriveAatFacts({ comments: [launch(1), verdict(2, 'pass', '', { login: 'mallory' })], mergeSha: M, listedAgents, engineLogins });
  assert.equal(unlisted.verdict, null);
  const otherSha = deriveAatFacts({ comments: [launch(1), verdict(2, 'pass', '', { merge: M2 })], mergeSha: M, listedAgents, engineLogins });
  assert.equal(otherSha.verdict, null);
  const noLaunch = deriveAatFacts({ comments: [verdict(1, 'pass')], mergeSha: M, listedAgents, engineLogins });
  assert.equal(noLaunch.verdict, null);
});

test('deriveAatFacts: a fail needs a known reason; the newest actionable verdict wins', () => {
  const listedAgents = [AGENT];
  const engineLogins = [ENGINE];
  const noReason = deriveAatFacts({ comments: [launch(1), verdict(2, 'fail')], mergeSha: M, listedAgents, engineLogins });
  assert.equal(noReason.verdict, null);
  const passThenFail = deriveAatFacts({
    comments: [launch(1), verdict(2, 'pass'), verdict(3, 'fail', ' reason=quality')],
    mergeSha: M,
    listedAgents,
    engineLogins,
  });
  assert.deepEqual(passThenFail.verdict, { verdict: 'fail', reason: 'quality' });
  const failThenPass = deriveAatFacts({
    comments: [launch(1), verdict(2, 'fail', ' reason=scope'), verdict(3, 'pass')],
    mergeSha: M,
    listedAgents,
    engineLogins,
  });
  assert.deepEqual(failThenPass.verdict, { verdict: 'pass', reason: null });
});

test('deriveAatFacts: a newer launch for the sha drops verdicts posted before it', () => {
  const facts = deriveAatFacts({
    comments: [launch(1), verdict(2, 'pass'), launch(3)],
    mergeSha: M,
    listedAgents: [AGENT],
    engineLogins: [ENGINE],
  });
  assert.equal(facts.verdict, null);
});

test('deriveAatFacts: waives count only from the engine and only for their sha', () => {
  const facts = deriveAatFacts({
    comments: [waive(1, 'manual'), waive(2, 'skipped', { merge: M2 }), waive(3, 'skipped', { login: 'mallory' })],
    mergeSha: M,
    listedAgents: [AGENT],
    engineLogins: [ENGINE],
  });
  assert.deepEqual([...facts.waives], ['manual']);
});

test('aatSatisfied: a pass for the sha satisfies, whatever the field says; a bare Passed does not', () => {
  assert.equal(aatSatisfied({ acceptance: 'Passed', mergeSha: M, verdict: { verdict: 'pass' }, waives: new Set() }), true);
  assert.equal(aatSatisfied({ acceptance: 'Failed', mergeSha: M, verdict: { verdict: 'pass' }, waives: new Set() }), true);
  assert.equal(aatSatisfied({ acceptance: 'Passed', mergeSha: M, verdict: null, waives: new Set() }), false);
  assert.equal(aatSatisfied({ acceptance: 'Pending', mergeSha: M, verdict: null, waives: new Set() }), false);
  assert.equal(aatSatisfied({ acceptance: 'Passed', mergeSha: null, verdict: { verdict: 'pass' }, waives: new Set() }), false);
});

test('aatSatisfied: Manual and Skipped need a waive bound to the same kind; a bound waive outranks a newer fail', () => {
  assert.equal(aatSatisfied({ acceptance: 'Manual', mergeSha: M, verdict: null, waives: new Set(['manual']) }), true);
  assert.equal(aatSatisfied({ acceptance: 'Manual', mergeSha: M, verdict: null, waives: new Set() }), false);
  assert.equal(aatSatisfied({ acceptance: 'Skipped', mergeSha: M, verdict: null, waives: new Set(['skipped']) }), true);
  assert.equal(aatSatisfied({ acceptance: 'Skipped', mergeSha: M, verdict: null, waives: new Set(['manual']) }), false);
  assert.equal(
    aatSatisfied({ acceptance: 'Manual', mergeSha: M, verdict: { verdict: 'fail', reason: 'quality' }, waives: new Set(['manual']) }),
    true,
  );
});

const candidate = (overrides) => ({ number: 1, stage: 'In UAT', mergeSha: M, inScope: true, satisfied: false, acceptance: 'Failed', ...overrides });

test('evaluateProdGate: dry-run lists what would block and never fails', () => {
  const result = evaluateProdGate({ mode: 'dry-run', candidates: [candidate({ number: 7 })] });
  assert.equal(result.pass, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.wouldBlock.map((item) => item.number), [7]);
});

test('evaluateProdGate: on fails on an unsatisfied in-scope merge; satisfied, out-of-scope and unknown-stage merges pass', () => {
  const candidates = [
    candidate({ number: 1 }),
    candidate({ number: 2, satisfied: true }),
    candidate({ number: 3, stage: 'In progress' }),
    candidate({ number: 4, inScope: false }),
    candidate({ number: 5, mergeSha: null }),
    candidate({ number: 6, stage: 'In Main' }),
  ];
  const result = evaluateProdGate({ mode: 'on', candidates });
  assert.equal(result.pass, false);
  assert.deepEqual(result.blocking.map((item) => item.number), [1, 6]);
  assert.equal(evaluateProdGate({ mode: 'on', candidates: [candidate({ satisfied: true })] }).pass, true);
});

test('evaluateProdGate: an override passes on and records what it overrode', () => {
  const result = evaluateProdGate({ mode: 'on', candidates: [candidate({ number: 9 })], overrideReason: 'owner waiver' });
  assert.equal(result.pass, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.overridden.map((item) => item.number), [9]);
  assert.equal(result.override, 'owner waiver');
});

test('renderSummary names the blocked issues and the result', () => {
  const result = evaluateProdGate({ mode: 'on', candidates: [candidate({ number: 12 })] });
  const text = renderSummary({ mode: 'on', promotedSha: P, result });
  assert.match(text, /#12 \| In UAT/);
  assert.match(text, /Result: \*\*blocked\*\*/);
});

const issueRow = (number) => ({ issue: { number, repository: { name: 'r', owner: { login: 'o' } } } });
const fieldEntry = (fieldId, name) => ({ field_id: fieldId, single_select_option: { name } });
const issueBody = (number, { stage = 'In UAT', acceptance = 'Pending', labels = [] } = {}) => ({
  number,
  labels,
  issue_field_values: [fieldEntry(11, stage), ...(acceptance ? [fieldEntry(12, acceptance)] : [])],
});
const mergedPr = (mergeSha) => [{ merged: true, base: 'main', mergedAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T10:00:00Z', mergeSha }];
const DEFS = [
  { id: 11, name: 'Stage' },
  { id: 12, name: 'Acceptance' },
];

function fakeDeps({ defs = DEFS, rows, issues, prs, comments = {}, contained = () => true }) {
  return {
    restFn: async (_method, path) => {
      if (path.startsWith('/orgs/')) return defs;
      const match = /\/issues\/(\d+)$/.exec(path);
      if (match) return issues[match[1]];
      throw new Error(`unexpected GET ${path}`);
    },
    listProjectIssues: async () => rows,
    listLinkedPrs: async ({ issueNumber }) => prs[issueNumber] || [],
    fetchAllPages: async ({ path }) => {
      const match = /issues\/(\d+)\/comments/.exec(path);
      return comments[match[1]] || [];
    },
    promotedContains: async ({ mergeSha }) => contained(mergeSha),
  };
}

test('collectCandidates: keeps in-scope gated issues and computes satisfaction from their comments', async () => {
  const deps = fakeDeps({
    rows: [issueRow(1), issueRow(2), issueRow(3)],
    issues: {
      1: issueBody(1, { stage: 'In UAT', acceptance: 'Passed' }),
      2: issueBody(2, { stage: 'In UAT', acceptance: 'Pending' }),
      3: issueBody(3, { stage: 'In progress', acceptance: 'Pending' }),
    },
    prs: { 1: mergedPr(M), 2: mergedPr(M2), 3: mergedPr(M) },
    comments: { 1: [launch(1), verdict(2, 'pass')] },
    contained: (sha) => sha === M,
  });
  const result = await collectCandidates({ owner: 'o', repo: 'r', promotedSha: P, token: 't', projectId: 'p', statusFieldId: 's', config: CONFIG, deps });
  assert.equal(result.acceptanceEnabled, true);
  assert.deepEqual(result.candidates, [{ number: 1, stage: 'In UAT', mergeSha: M, inScope: true, satisfied: true, acceptance: 'Passed' }]);
});

test('collectCandidates: a missing Acceptance org field disables the gate and reads no board', async () => {
  let listed = false;
  const deps = fakeDeps({ defs: [{ id: 11, name: 'Stage' }], rows: [], issues: {}, prs: {} });
  deps.listProjectIssues = async () => {
    listed = true;
    return [];
  };
  const result = await collectCandidates({ owner: 'o', repo: 'r', promotedSha: P, token: 't', projectId: 'p', statusFieldId: 's', config: CONFIG, deps });
  assert.deepEqual(result, { acceptanceEnabled: false, candidates: [] });
  assert.equal(listed, false);
});

test('collectCandidates: the scope label limits the candidates', async () => {
  const deps = fakeDeps({
    rows: [issueRow(1), issueRow(2)],
    issues: {
      1: issueBody(1, { labels: [{ name: 'pipeline-beta' }] }),
      2: issueBody(2, { labels: [] }),
    },
    prs: { 1: mergedPr(M), 2: mergedPr(M) },
  });
  const result = await collectCandidates({
    owner: 'o',
    repo: 'r',
    promotedSha: P,
    token: 't',
    projectId: 'p',
    statusFieldId: 's',
    scopeLabel: 'pipeline-beta',
    config: CONFIG,
    deps,
  });
  assert.deepEqual(result.candidates.map((item) => item.number), [1]);
});

const GATE_ENV = {
  GITHUB_REPOSITORY: 'o/r',
  AAT_GATE_READ_TOKEN: 't',
  GH_PROJECT_ID: 'p',
  GH_STATUS_FIELD_ID: 's',
  PROMOTED_SHA: P,
};
const quiet = () => {};
const blockingCollect = async () => ({ acceptanceEnabled: true, candidates: [candidate({ number: 7 })] });
const brokenCollect = async () => {
  throw new Error('GitHub API 502');
};

test('runGate: AAT_GATE unset makes no API call and passes', async () => {
  let called = false;
  const out = await runGate({ env: { ...GATE_ENV }, collect: async () => { called = true; }, loadConfigFn: () => CONFIG, log: quiet });
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

test('runGate: on fails closed on an API error, and an override lets it through', async () => {
  const closed = await runGate({ env: { ...GATE_ENV, AAT_GATE: 'on' }, collect: brokenCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(closed.exitCode, 1);
  assert.match(closed.summary, /GitHub API 502/);
  const overridden = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on', AAT_OVERRIDE_REASON: 'owner waiver' },
    collect: brokenCollect,
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  assert.equal(overridden.exitCode, 0);
});

test('runGate: dry-run never fails on an error, and a bad SHA fails only in on', async () => {
  const dry = await runGate({ env: { ...GATE_ENV, AAT_GATE: 'dry-run' }, collect: brokenCollect, loadConfigFn: () => CONFIG, log: quiet });
  assert.equal(dry.exitCode, 0);
  const badSha = { ...GATE_ENV, PROMOTED_SHA: 'main' };
  assert.equal((await runGate({ env: { ...badSha, AAT_GATE: 'on' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet })).exitCode, 1);
  assert.equal((await runGate({ env: { ...badSha, AAT_GATE: 'dry-run' }, collect: blockingCollect, loadConfigFn: () => CONFIG, log: quiet })).exitCode, 0);
});

test('runGate: a missing Acceptance field passes in on mode with a note', async () => {
  const out = await runGate({
    env: { ...GATE_ENV, AAT_GATE: 'on' },
    collect: async () => ({ acceptanceEnabled: false, candidates: [] }),
    loadConfigFn: () => CONFIG,
    log: quiet,
  });
  assert.equal(out.exitCode, 0);
  assert.match(out.summary, /gate is disabled/);
});
