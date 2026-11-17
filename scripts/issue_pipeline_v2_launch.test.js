'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLaunchAcked, buildLaunchFailed, buildLaunchRecord, deriveLaunchFacts, deliveryMethod, launchIssue,
} = require('./issue_pipeline_v2_launch');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { decide } = require('./issue_pipeline_v2_decide');
const { launchableAgents, loadConfig } = require('./issue_pipeline_v2_config');

const config = loadConfig();
const engine = ['pawpet-engine'];
const at = (minute) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00Z`;
const note = (body, minute, login = 'pawpet-engine') => ({ id: minute, user: { login }, body, created_at: at(minute) });

test('delivery method comes from the Delivery plan section, defaulting to PR', () => {
  assert.equal(deliveryMethod('### Delivery plan\n\nMethod: light-plan\nPlan: x'), 'light-plan');
  assert.equal(deliveryMethod('### Delivery plan\n\nmethod: Execute-Plan\n### Next\nMethod: PR'), 'execute-plan');
  assert.equal(deliveryMethod('### Other\nMethod: light-plan'), 'PR');
  assert.equal(deliveryMethod('### Delivery plan\n\nMethod: carrier-pigeon'), 'PR');
  assert.equal(deliveryMethod(''), 'PR');
});

test('launch facts: newest engine record decides, acked clears, others are ignored', () => {
  const base = { engineLogins: engine, labels: [], attempts: 1 };
  assert.deepEqual(deriveLaunchFacts({ ...base, comments: [] }), { failures: 1, busy: false });
  const started = note(buildLaunchRecord({ runId: 'r1', agent: 'pawpet-bot' }), 1);
  assert.deepEqual(deriveLaunchFacts({ ...base, comments: [started] }), {
    runId: 'r1', startedAt: Date.parse(at(1)), failures: 1, busy: false,
  });
  const failed = note(buildLaunchFailed({ agent: 'pawpet-bot', reason: 'boom' }), 2);
  assert.equal(deriveLaunchFacts({ ...base, comments: [started, failed] }).lastFailureAt, Date.parse(at(2)));
  assert.equal(deriveLaunchFacts({ ...base, comments: [started, failed] }).runId, undefined);
  const acked = note(buildLaunchAcked({ runId: 'r1' }), 3);
  assert.deepEqual(deriveLaunchFacts({ ...base, labels: ['busy'], comments: [started, failed, acked] }), { failures: 1, busy: true });
  const forged = note(buildLaunchRecord({ runId: 'evil', agent: 'pawpet-bot' }), 9, 'someone');
  assert.equal(deriveLaunchFacts({ ...base, comments: [started, forged] }).runId, 'r1', 'only engine comments count');
});

test('only agents whose runner the engine can start are launched', () => {
  assert.deepEqual(launchableAgents(config, 'PR'), ['pawpet-bot']);
  assert.deepEqual(launchableAgents(config, 'execute-plan'), ['pawpet-bot']);
  const ready = { mode: 'on', onBoard: true, stage: 'Ready', now: 1e12, wip: 0, deliveryMethod: 'light-plan' };
  assert.equal(decide(ready, config).agent, 'pawpet-bot');
  assert.deepEqual(
    [decide({ ...ready, launch: { failures: 1, lastFailureAt: 1e12 - 60 * 60 * 1000 } }, config)].map((a) => [a.type, a.attempts]),
    [['launch', 1]],
  );
});

function ctx(extra = {}) {
  const sent = [];
  return {
    sent,
    ctx: {
      owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config,
      fields: { attempts: { id: 3, name: 'Attempts', options: [] } },
      parsed: { attempts: 0, totalN: 0 }, assignees: [], counters: {}, facts: {}, dryRun: false,
      restFn: async (method, path, token, body) => { sent.push({ method, path, body }); return { id: 1 }; },
      ...extra,
    },
  };
}

test('apply launch: starts the run, records it, writes the failed-run count', async () => {
  const { sent, ctx: c } = ctx({ launchFn: async () => ({ runId: 'r9', agentUrl: 'https://cursor/x' }) });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 1 }, ctx: c });
  assert.match(sent[0].body.body, /v2:launch run=r9 agent=pawpet-bot/);
  assert.equal(sent[1].body.issue_field_values[0].value, 1);
  assert.deepEqual(result.applied.slice(0, 2), ['launch:pawpet-bot', 'comment:launch']);
});

test('apply launch: a failed API call is recorded and counted, not thrown', async () => {
  const { sent, ctx: c } = ctx({ launchFn: async () => { throw new Error('503'); } });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 }, ctx: c });
  assert.match(sent[0].body.body, /v2:launch-failed agent=pawpet-bot/);
  assert.equal(sent[1].body.issue_field_values[0].value, 1);
  assert.equal(result.applied[0], 'launch-failed:pawpet-bot');
});

test('apply launch: a dry run never starts a run', async () => {
  const { sent, ctx: c } = ctx({ dryRun: true, launchFn: async () => { throw new Error('must not run'); } });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 }, ctx: c });
  assert.deepEqual(sent, []);
  assert.ok(result.calls.some((call) => call.path === 'cursor:/v1/agents'));
});

test('apply set-stage In progress leaves the acked record', async () => {
  const { sent, ctx: c } = ctx({ facts: { launch: { runId: 'r9' } }, fields: { stage: { id: 1, name: 'Stage', options: ['In progress'] }, attempts: { id: 3, name: 'Attempts', options: [] } } });
  await applyAction({ action: { type: 'set-stage', to: 'In progress' }, ctx: c });
  assert.match(sent[0].body.body, /v2:launch-acked run=r9/);
});

test('launchIssue: busy label, run, and cleanup when the API fails', async () => {
  const labels = [];
  const deps = {
    safety: { preflightIssue: () => ({ ok: true }) },
    payload: { buildAgentPayload: () => ({}), buildAgentPrompt: () => 'prompt' },
    lib: { setLabels: async (o, r, n, add, remove) => labels.push([add, remove]) },
    launcher: { launchAgent: async () => ({ agent: { id: 'a', url: 'u' }, run: { id: 'r' } }) },
  };
  const issue = { number: 7, title: 't', body: 'b', labels: [] };
  assert.deepEqual(await launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', deps }), { runId: 'r', agentId: 'a', agentUrl: 'u' });
  assert.deepEqual(labels, [[['busy'], []]]);
  labels.length = 0;
  deps.launcher = { launchAgent: async () => { throw new Error('down'); } };
  await assert.rejects(launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', deps }), /down/);
  assert.deepEqual(labels, [[['busy'], []], [[], ['busy']]]);
  deps.safety = { preflightIssue: () => ({ ok: false, reason: 'nope' }) };
  await assert.rejects(launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', deps }), /preflight: nope/);
});
