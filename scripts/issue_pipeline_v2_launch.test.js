'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLaunchAcked,
  buildLaunchFailed,
  buildLaunchRecord,
  deriveLaunchFacts,
  deliveryMethod,
  doorbellRingFailed,
  launchIssue,
  STAGE_PROMPTS,
  STAGE_PROMPTS_SIGNED,
} = require('./issue_pipeline_v2_launch');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { decide } = require('./issue_pipeline_v2_decide');
const { launchableAgents, loadConfig } = require('./issue_pipeline_v2_config');

const config = loadConfig();
const engine = ['pawpet-engine'];
const at = (minute) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00Z`;
const note = (body, minute, login = 'pawpet-engine') => ({ id: minute, user: { login }, body, created_at: at(minute) });

test('delivery method accepts the formats real issues use: bold, backticks, tables', () => {
  assert.equal(deliveryMethod('### Delivery plan\n\n**Method:** `light-plan` (3 phases + release)\n\n**Goal:** x'), 'light-plan', '#1545');
  assert.equal(deliveryMethod('### Delivery plan\n\n| Field | Value |\n|---|---|\n| **Mechanism** | `PR` — one PR to `main` |'), 'PR', '#2335');
  assert.equal(deliveryMethod('### Delivery plan\n\n**Method:** execute-plan'), 'execute-plan');
  assert.equal(deliveryMethod('### Delivery plan\n\n- Method: `Light-Plan`\n'), 'light-plan', 'case-insensitive');
  assert.equal(deliveryMethod('### Delivery plan\n\n**Method:** `PR`\nlater light-plan is mentioned'), 'PR', 'the first one after the label wins');
  assert.equal(deliveryMethod('### Delivery plan\n\nThe plan is a light-plan.'), 'PR', 'needs the Method label');
  assert.equal(deliveryMethod('### Scope\n\n**Method:** `light-plan`'), 'PR', 'only inside the Delivery plan section');
});

test('delivery method needs a whole token in a field position', () => {
  assert.equal(deliveryMethod('### Delivery plan\n\nMethod: execute-plan-beta'), 'PR', 'suffix');
  assert.equal(deliveryMethod('### Delivery plan\n\nMethod: `light-plan-v2`'), 'PR', 'suffix in backticks');
  assert.equal(deliveryMethod('### Delivery plan\n\nThe method: light-plan'), 'PR', 'incidental prose');
  assert.equal(deliveryMethod('### Delivery plan\n\nWe chose the Method: light-plan because'), 'PR', 'mid-line');
  assert.equal(deliveryMethod('### Delivery plan\n\nintro\n1. **Method:** `light-plan`'), 'light-plan', 'list item');
  assert.equal(deliveryMethod('### Delivery plan\n\n> Method: execute-plan'), 'execute-plan', 'quote');
});

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
  const started = note(buildLaunchRecord({ runId: 'r1', agent: 'cursor-a', purpose: 'delivery' }), 1);
  assert.deepEqual(deriveLaunchFacts({ ...base, comments: [started] }), {
    runId: 'r1',
    startedAt: Date.parse(at(1)),
    failures: 1,
    busy: false,
    deliveryAgentId: 'cursor-a',
  });
  const failed = note(buildLaunchFailed({ agent: 'cursor-a', reason: 'boom' }), 2);
  assert.equal(deriveLaunchFacts({ ...base, comments: [started, failed] }).lastFailureAt, Date.parse(at(2)));
  assert.equal(deriveLaunchFacts({ ...base, comments: [started, failed] }).runId, undefined);
  const acked = note(buildLaunchAcked({ runId: 'r1' }), 3);
  assert.deepEqual(deriveLaunchFacts({ ...base, labels: ['busy'], comments: [started, failed, acked] }), { failures: 1, busy: true });
  const forged = note(buildLaunchRecord({ runId: 'evil', agent: 'cursor-a', purpose: 'delivery' }), 9, 'someone');
  assert.equal(deriveLaunchFacts({ ...base, comments: [started, forged] }).runId, 'r1', 'only engine comments count');
});

test('launch facts: risky-scope preflight failure is flagged for pause', () => {
  const risky = note(
    buildLaunchFailed({ agent: 'cursor-a', reason: 'preflight: risky scope detected: migrations' }),
    2,
  );
  const facts = deriveLaunchFacts({ engineLogins: engine, labels: [], attempts: 0, comments: [risky] });
  assert.equal(facts.riskyScopePreflight, true);
  assert.match(risky.body, /Blocked=sensitive/);
  assert.match(risky.body, /owner-approved-delivery/);
});

test('only agents whose runner the engine can start are launched', () => {
  assert.deepEqual(launchableAgents(config, 'PR'), ['cursor-a', 'cursor-b']);
  assert.deepEqual(launchableAgents(config, 'execute-plan'), ['cursor-a']);
  const ready = { mode: 'on', onBoard: true, stage: 'Ready', now: 1e12, wip: 0, deliveryMethod: 'light-plan' };
  assert.equal(decide(ready, config).agent, 'cursor-a');
  assert.deepEqual(
    [decide({ ...ready, launch: { failures: 1, lastFailureAt: 1e12 - 60 * 60 * 1000 } }, config)].map((a) => [a.type, a.attempts]),
    [['launch', 1]],
  );
});

const launchFields = {
  stage: { id: 1, name: 'Stage', options: ['In progress'] },
  blocked: { id: 2, name: 'Blocked', options: [] },
  attempts: { id: 3, name: 'Attempts', options: [] },
};

function ctx(extra = {}) {
  const sent = [];
  const issuePath = '/repos/o/r/issues/7';
  return {
    sent,
    ctx: {
      owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config,
      fields: launchFields,
      parsed: { attempts: 0 }, assignees: [], counters: {}, facts: {}, dryRun: false,
      restFn: async (method, path, token, body) => {
        sent.push({ method, path, body });
        if (method === 'GET' && path === issuePath) {
          return { number: 7, issue_field_values: [{ field_id: 3, value: 0 }] };
        }
        return { id: 1 };
      },
      ...extra,
    },
  };
}

test('apply launch: starts the run, records it, writes the failed-run count', async () => {
  const { sent, ctx: c } = ctx({ launchFn: async () => ({ runId: 'r9', agentUrl: 'https://cursor/x' }) });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 1 }, ctx: c });
  assert.match(sent[0].body.body, /v2:launch-pending agent=pawpet-bot/, 'pending record is written before the handoff');
  assert.match(sent.find((c) => /v2:launch run=r9 agent=pawpet-bot/.test(c.body?.body || '')).body.body, /v2:launch run=r9/);
  const patch = sent.find((c) => c.body?.issue_field_values);
  assert.equal(patch.body.issue_field_values.find((v) => v.field_id === 3).value, 1);
  assert.equal(result.applied[0], 'launch:pawpet-bot');
  assert.ok(result.applied.includes('comment:launch'));
});

test('apply launch: a failed API call is recorded and counted, not thrown', async () => {
  const { sent, ctx: c } = ctx({ launchFn: async () => { throw new Error('503'); } });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 }, ctx: c });
  assert.match(sent.find((c) => /v2:launch-failed/.test(c.body?.body || '')).body.body, /v2:launch-failed agent=pawpet-bot/);
  const patch = sent.find((c) => c.body?.issue_field_values);
  assert.equal(patch.body.issue_field_values.find((v) => v.field_id === 3).value, 1);
  assert.equal(result.applied[0], 'launch-failed:pawpet-bot');
});

test('apply launch: a dry run never starts a run', async () => {
  const { sent, ctx: c } = ctx({ dryRun: true, launchFn: async () => { throw new Error('must not run'); } });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 }, ctx: c });
  assert.deepEqual(sent, []);
  assert.ok(result.calls.some((call) => call.path === 'cursor:/v1/agents'));
});

test('apply set-stage In progress leaves the acked record', async () => {
  const { sent, ctx: c } = ctx({ facts: { launch: { runId: 'r9' } } });
  await applyAction({ action: { type: 'set-stage', to: 'In progress', row: 'ready.launched' }, ctx: c });
  assert.match(sent[0].body.body, /v2:launch-acked run=r9/);
});

test('launchIssue: busy label, run, and cleanup when the API fails', async () => {
  const labels = [];
  const deps = {
    safety: { preflightIssue: () => ({ ok: true }) },
    lib: { setLabels: async (o, r, n, add, remove) => labels.push([add, remove]) },
    runners: { cursor: { launch: async () => ({ runId: 'r', agentUrl: 'u' }) } },
  };
  const issue = { number: 7, title: 't', body: 'b', labels: [] };
  assert.deepEqual(
    await launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', agent: 'cursor-a', config, deps }),
    { runId: 'r', agentUrl: 'u' },
  );
  assert.deepEqual(labels, [[['busy'], []]]);
  labels.length = 0;
  deps.runners = { cursor: { launch: async () => { throw new Error('down'); } } };
  await assert.rejects(launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', agent: 'cursor-a', config, deps }), /down/);
  assert.deepEqual(labels, [[['busy'], []], [[], ['busy']]]);
  deps.safety = { preflightIssue: () => ({ ok: false, reason: 'nope' }) };
  await assert.rejects(launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', agent: 'cursor-a', config, deps }), /preflight: nope/);
});

function realSafetyDeps(launches) {
  return {
    safety: require('../.github/scripts/agent-safety-lib'),
    lib: { setLabels: async () => {} },
    runners: {
      cursor: {
        launch: async (args) => {
          launches.push(args);
          return { runId: 'r', agentUrl: 'u' };
        },
      },
    },
  };
}

test('launchIssue (real preflight): a Ready issue with none of the retired approval labels is launched', async () => {
  const launches = [];
  const issue = { number: 7, title: 'Fix a thing', body: '### Summary\n\nsmall change', labels: [{ name: 'pipeline-beta' }] };
  const run = await launchIssue({
    owner: 'o',
    repo: 'r',
    issue,
    token: 't',
    apiKey: 'k',
    agent: 'cursor-a',
    config,
    deps: realSafetyDeps(launches),
  });
  assert.equal(run.runId, 'r');
  assert.equal(launches.length, 1);
});

test('launchIssue (real preflight): the blocking-label and risky-scope checks still stop a delivery', async () => {
  const launches = [];
  const blocked = { number: 7, title: 't', body: 'b', labels: [{ name: 'blocked' }] };
  await assert.rejects(
    launchIssue({ owner: 'o', repo: 'r', issue: blocked, token: 't', apiKey: 'k', agent: 'cursor-a', config, deps: realSafetyDeps(launches) }),
    /preflight: .*blocking label/,
  );
  assert.equal(launches.length, 0);
});

test('doorbellRingFailed: uses module-scope runners without ReferenceError', async () => {
  const engineLogins = ['pawpet-engine'];
  const at = (minute) => `2026-11-17T10:${String(minute).padStart(2, '0')}:00Z`;
  const note = (body, minute, login = 'pawpet-engine') => ({ id: minute, user: { login }, body, created_at: at(minute) });
  const comments = [
    note(
      buildLaunchRecord({
        runId: 'r1',
        agent: 'cursor-a',
        purpose: 'doorbell',
        stage: 'To do',
        nonce: 'abc123',
      }),
      1,
    ),
  ];
  const failed = await doorbellRingFailed({
    comments,
    engineLogins,
    config,
    agentId: 'cursor-a',
    stage: 'To do',
    sinceMs: 0,
    owner: 'o',
    repo: 'r',
    token: 't',
    io: { runners: { cursor: { status: async () => 'failed' } } },
  });
  assert.equal(failed, true);
});

test('launchIssue: a spec, review or intent-review doorbell skips the preflight but sets busy', async () => {
  for (const stage of ['To do', 'In analysis', 'In Main']) {
    const launches = [];
    const labels = [];
    const deps = realSafetyDeps(launches);
    deps.lib = { setLabels: async (o, r, n, add, remove) => labels.push([add, remove]) };
    // `busy` and `blocked` would stop a delivery; a spec pass on such an issue must still run
    const issue = { number: 7, title: 't', body: 'b', labels: [{ name: 'blocked' }, { name: 'busy' }] };
    await launchIssue({ owner: 'o', repo: 'r', issue, token: 't', apiKey: 'k', agent: 'cursor-a', config, stage, purpose: 'doorbell', deps });
    assert.equal(launches.length, 1, stage);
    assert.deepEqual(labels[0], [['busy'], []], `${stage}: busy at handoff`);
    if (stage === 'In Main') {
      assert.match(STAGE_PROMPTS[stage], /INTENT REVIEW/);
    } else {
      assert.ok(STAGE_PROMPTS_SIGNED[stage].includes('pipeline_verdict.js'), stage);
    }
  }
});

test('apply launch: a started run is never recorded as a failure when the record comment fails', async () => {
  let launches = 0;
  const bodies = [];
  const { ctx: c } = ctx({
    launchFn: async () => { launches += 1; return { runId: 'r1' }; },
    restFn: async (method, path, token, body) => {
      bodies.push(body);
      if (String(body?.body).includes('v2:launch run=')) throw new Error('comment API down');
      return {};
    },
  });
  await assert.rejects(
    applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 }, ctx: c }),
    /comment API down/,
  );
  assert.equal(launches, 1);
  assert.ok(!bodies.some((b) => String(b?.body).includes('v2:launch-failed')), 'no launch-failed comment follows a run that started');
});

test('runner: one failing issue does not stop the board, and two Ready issues respect the WIP limit', async () => {
  const { tick } = require('./issue_pipeline_v2');
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  const origError = console.error;
  console.error = () => {};
  try {
    const ready = (number) => ({
      number,
      body: '',
      labels: [{ name: 'pipeline-beta' }],
      issue_field_values: [{ field_id: 1, single_select_option: { name: 'Ready' } }],
    });
    const board = [1, 2, 3, 4].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }));
    const result = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config,
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => board,
        getIssue: async (n) => ready(n),
        listIssueComments: async () => [],
        applyAction: async ({ action, ctx: c }) => {
          if (c.issueNumber === 1) throw new Error('boom');
          if (c.issueNumber === 2) return { applied: [`launch-failed:${action.agent}`], calls: [] };
          return { applied: [`${action.type}:${action.agent}`], calls: [] };
        },
      },
    });
    assert.deepEqual(result.errors, [{ issue: 1, message: 'boom' }]);
    const types = result.actions.map((entry) => [entry.issue, entry.action.type, entry.action.reason]);
    // wip limit is 2: 1 failed to apply and 2's launch failed (neither takes a slot), 3 and 4 launch
    assert.deepEqual(types.map((t) => t[1]), ['launch', 'launch', 'launch', 'launch']);
    board.push({ issue: { number: 5, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } });
    const third = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config,
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => board.slice(2),
        getIssue: async (n) => ready(n),
        listIssueComments: async () => [],
        applyAction: async ({ action }) => ({ applied: [`${action.type}:${action.agent}`], calls: [] }),
      },
    });
    assert.deepEqual(third.actions.map((entry) => entry.action.reason || entry.action.type), ['launch', 'launch', 'ready.queued']);
  } finally {
    console.error = origError;
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('launch prompt carries the delivery method; PR adds nothing', async () => {
  const prompts = [];
  const deps = {
    safety: { preflightIssue: () => ({ ok: true }) },
    lib: { setLabels: async () => {} },
    runners: {
      cursor: {
        launch: async ({ method }) => {
          const { METHOD_PROMPTS } = require('./issue_pipeline_v2_launch');
          prompts.push(METHOD_PROMPTS[method] || '');
          return { runId: 'r', agentUrl: '' };
        },
      },
    },
  };
  const issue = { number: 7, title: 't', body: 'b', labels: [] };
  for (const method of ['PR', 'light-plan', 'execute-plan']) {
    await launchIssue({
      owner: 'o',
      repo: 'r',
      issue,
      token: 't',
      apiKey: 'k',
      agent: 'cursor-a',
      config,
      method,
      deps,
    });
  }
  assert.equal(prompts[0], '');
  assert.match(prompts[1], /light-plan\/SKILL\.md/);
  assert.match(prompts[2], /execute-plan\/SKILL\.md/);
});

test('Ready with a busy issue and no launch record moves on; the dry-run plan shows the busy label', async () => {
  const ready = { mode: 'on', onBoard: true, stage: 'Ready', now: 1e12, wip: 0, deliveryMethod: 'PR', launch: { busy: true, failures: 0 } };
  assert.deepEqual([decide(ready, config).type, decide(ready, config).to], ['set-stage', 'In progress']);
  const { ctx: c } = ctx({ dryRun: true });
  const result = await applyAction({ action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 }, ctx: c });
  assert.deepEqual(
    result.calls.find((call) => call.path === '/repos/o/r/issues/7/labels'),
    { method: 'POST', path: '/repos/o/r/issues/7/labels', body: { labels: ['busy'] } },
  );
});

test('stage prompts exist for the spec and review doorbells', () => {
  assert.match(STAGE_PROMPTS['To do'], /SPEC PASS[\s\S]*Blocked[\s\S]*question/);
  assert.match(STAGE_PROMPTS['In analysis'], /ADVERSARIAL REVIEW/);
});

test('deriveLaunchFacts: a pending record with no busy label is one failed start; with busy it is in flight', () => {
  const engineLogins = ['pawpet-bot'];
  const pending = {
    body: '<!-- v2:launch-pending agent=pawpet-bot purpose=delivery -->\nLaunching',
    user: { login: 'pawpet-bot' },
    created_at: '2026-11-18T10:00:00Z',
  };
  const notBusy = deriveLaunchFacts({ comments: [pending], engineLogins, labels: [], attempts: 1 });
  assert.equal(notBusy.runId, undefined);
  assert.equal(notBusy.failures, 2);
  assert.ok(notBusy.lastFailureAt > 0);
  const busy = deriveLaunchFacts({ comments: [pending], engineLogins, labels: ['busy'], attempts: 1 });
  assert.equal(busy.runId, undefined);
  assert.equal(busy.failures, 1);
  assert.equal(busy.busy, true);
});

test('a pending delivery record is the agent lookup and counts as an engine-started run', () => {
  const { newestDeliveryLaunchAgentId } = require('./issue_pipeline_v2_launch');
  const { engineStartedRun } = require('./issue_pipeline_v2_release');
  const engine = new Set(['pawpet-bot']);
  const pending = {
    body: '<!-- v2:launch-pending agent=pawpet-bot purpose=delivery -->\nLaunching',
    user: { login: 'pawpet-bot' },
    created_at: '2026-11-18T10:00:00Z',
  };
  const failed = {
    body: '<!-- v2:launch-failed agent=pawpet-claude -->\nLaunching failed',
    user: { login: 'pawpet-bot' },
    created_at: '2026-11-18T10:05:00Z',
  };
  assert.equal(newestDeliveryLaunchAgentId({ comments: [pending], engineLogins: ['pawpet-bot'] }), 'pawpet-bot');
  assert.equal(newestDeliveryLaunchAgentId({ comments: [pending, failed], engineLogins: ['pawpet-bot'] }), 'pawpet-bot');
  assert.equal(engineStartedRun(pending, engine), true);
  assert.equal(engineStartedRun(failed, engine), false, 'a failed start never counts as a run');
});
