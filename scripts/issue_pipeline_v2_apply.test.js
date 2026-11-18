'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAction, doorbellAssignees } = require('./issue_pipeline_v2_apply');
const { checkEngineIdentity, writesAllowed } = require('./issue_pipeline_v2_identity');

const { validateConfig, loadConfig } = require('./issue_pipeline_v2_config');
const config = validateConfig({
  agents: [
    { login: 'pawpet-bot', runner: 'cursor', methods: ['PR', 'light-plan', 'execute-plan'] },
    { login: 'pawpet-claude', runner: 'claude', methods: ['PR', 'light-plan'] },
  ],
  engine: { logins: ['engine'] },
  launchRunners: ['cursor'],
  limits: loadConfig().limits,
  aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
});
const prodConfig = loadConfig();
const fields = {
  stage: { id: 1, name: 'Stage', options: ['Ready', 'Done'] },
  blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
  attempts: { id: 3, name: 'Attempts', options: [] },
};

function ctx(extra = {}) {
  return {
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config, fields,
    parsed: { attempts: 0 }, assignees: ['human', 'pawpet-bot'], counters: {}, facts: {},
    dryRun: false, ...extra,
  };
}

function issueFromParsed(parsed = {}) {
  const issue_field_values = [];
  if (parsed.stage) {
    issue_field_values.push({ field_id: fields.stage.id, single_select_option: { name: parsed.stage } });
  }
  if (parsed.blocked) {
    issue_field_values.push({ field_id: fields.blocked.id, single_select_option: { name: parsed.blocked } });
  }
  if (parsed.attempts) {
    issue_field_values.push({ field_id: fields.attempts.id, value: parsed.attempts });
  }
  return { number: 7, issue_field_values };
}

function recorder(getIssueSnapshot) {
  const sent = [];
  const issuePath = '/repos/o/r/issues/7';
  return {
    sent,
    restFn: async (method, path, token, body) => {
      sent.push({ method, path, token, body });
      if (method === 'GET' && path === issuePath) {
        const snap = typeof getIssueSnapshot === 'function' ? getIssueSnapshot() : getIssueSnapshot;
        return issueFromParsed(snap);
      }
      return { id: 1 };
    },
  };
}

test('doorbell keeps humans and replaces agents', () => {
  assert.deepEqual(doorbellAssignees(['human', 'pawpet-bot'], 'pawpet-claude', config), ['human', 'pawpet-claude']);
  assert.deepEqual(doorbellAssignees(undefined, 'pawpet-bot', config), ['pawpet-bot']);
});

test('request-spec posts the marker comment then rings the agent', async () => {
  const { sent, restFn } = recorder();
  const result = await applyAction({
    action: { type: 'request-spec', agent: 'pawpet-claude' },
    ctx: ctx({ restFn, launchFn: async () => ({ runId: 'r0' }) }),
  });
  assert.equal(sent[0].method, 'POST');
  assert.match(sent[0].body.body, /v2:spec-request/);
  assert.equal(sent[1].method, 'PATCH');
  assert.deepEqual(sent[1].body.assignees, ['human', 'pawpet-claude']);
  assert.equal(sent[2], undefined, 'non-startable runners are assigned only');
  assert.ok(!result.applied.some((entry) => entry.startsWith('doorbell')));
});

test('request-spec also starts a Cursor run for an agent whose runner the engine can launch', async () => {
  const { restFn } = recorder();
  const launches = [];
  const withRunners = config;
  const launchFn = async (args) => { launches.push(args); return { runId: 'r' }; };
  const bot = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-bot' }, ctx: ctx({ restFn, launchFn, config: withRunners }) });
  assert.equal(launches[0].agent, 'pawpet-bot');
  assert.equal(launches[0].purpose, 'doorbell');
  assert.ok(bot.applied.includes('doorbell:pawpet-bot'));
  const claude = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-claude' }, ctx: ctx({ restFn, launchFn, config: withRunners }) });
  assert.equal(launches.length, 1, 'a runner the engine cannot start is only assigned');
  assert.ok(!claude.applied.some((entry) => entry.startsWith('doorbell')));
  const dry = await applyAction({ action: { type: 'request-review', agent: 'pawpet-bot', hash: 'h' }, ctx: ctx({ restFn, launchFn, config: withRunners, dryRun: true }) });
  assert.equal(launches.length, 1, 'a dry run sends nothing');
  assert.ok(dry.calls.some((call) => call.path === 'cursor:/v1/agents' && call.body.stage === 'In analysis'));
  assert.ok(
    dry.calls.some((call) => call.method === 'POST' && call.path.endsWith('/labels') && call.body?.labels?.includes('busy')),
    'dry-run plan includes the busy label handoff',
  );
});

test('request-intent-review also rings a launchable agent, for the In Main stage', async () => {
  const { restFn } = recorder();
  const launches = [];
  const withRunners = { ...config, launchRunners: ['cursor'], agents: [{ login: 'pawpet-bot', runner: 'cursor', methods: ['PR'] }] };
  const result = await applyAction({
    action: { type: 'request-intent-review', agent: 'pawpet-bot' },
    ctx: ctx({
      restFn,
      config: withRunners,
      launchFn: async (args) => {
        launches.push(args);
        return { runId: 'r-main' };
      },
      facts: { stage: 'In Main', delivery: {} },
    }),
  });
  assert.equal(launches[0].agent, 'pawpet-bot');
  assert.equal(launches[0].stage, 'In Main');
  assert.equal(launches[0].purpose, 'doorbell');
  assert.ok(result.applied.includes('doorbell:pawpet-bot'));
});

test('a failed doorbell launch never fails the tick', async () => {
  const { restFn } = recorder();
  const withRunners = { ...config, launchRunners: ['cursor'], agents: [{ login: 'pawpet-bot', runner: 'cursor', methods: ['PR'] }] };
  const result = await applyAction({
    action: { type: 'request-spec', agent: 'pawpet-bot' },
    ctx: ctx({ restFn, config: withRunners, launchFn: async () => { throw new Error('cursor down'); } }),
  });
  assert.ok(result.applied.includes('doorbell-failed:pawpet-bot:cursor down'), 'the reason is kept');
});

test('a request that fails after others went out carries what was applied', async () => {
  let calls = 0;
  const restFn = async () => { calls += 1; if (calls === 2) throw new Error('assign failed'); return { id: 1 }; };
  await assert.rejects(
    applyAction({ action: { type: 'request-spec', agent: 'pawpet-bot' }, ctx: ctx({ restFn }) }),
    (error) => error.message === 'assign failed' && JSON.stringify(error.applied) === JSON.stringify(['comment:spec-request']),
  );
});

test('a doorbell that rejects with a non-Error keeps its reason', async () => {
  const { restFn } = recorder();
  const withRunners = { ...config, launchRunners: ['cursor'], agents: [{ login: 'pawpet-bot', runner: 'cursor', methods: ['PR'] }] };
  const result = await applyAction({
    action: { type: 'request-spec', agent: 'pawpet-bot' },
    ctx: ctx({ restFn, config: withRunners, launchFn: async () => { throw 'rate limited'; } }),
  });
  assert.ok(result.applied.includes('doorbell-failed:pawpet-bot:rate limited'));
});

test('request-review carries the hash', async () => {
  const { sent, restFn } = recorder();
  await applyAction({ action: { type: 'request-review', agent: 'pawpet-bot', hash: 'abc' }, ctx: ctx({ restFn }) });
  assert.match(sent[0].body.body, /v2:review-request hash=abc assigned=pawpet-bot/);
});

test('reassign edits the held request with history and bumps attempts', async () => {
  const { sent, restFn } = recorder();
  const facts = { spec: { commentId: 55, assignedTo: 'pawpet-bot', timedOut: [] } };
  await applyAction({
    action: { type: 'reassign', stage: 'To do', agent: 'pawpet-claude', attempts: 1 },
    ctx: ctx({ restFn, facts }),
  });
  assert.equal(sent[0].method, 'PATCH');
  assert.equal(sent[0].path, '/repos/o/r/issues/comments/55');
  assert.match(sent[0].body.body, /assigned=pawpet-claude/);
  assert.match(sent[0].body.body, /pawpet-bot/);
  assert.ok(sent.at(-1).body.issue_field_values, 'attempts written');
});

test('wake posts the marker once and rings the agent', async () => {
  const { sent, restFn } = recorder();
  await applyAction({ action: { type: 'wake-stage-agent', agent: 'pawpet-bot', commentId: 99 }, ctx: ctx({ restFn }) });
  assert.match(sent[0].body.body, /v2:wake comment=99/);
});

test('set-stage Done writes the field and closes as completed', async () => {
  const { sent, restFn } = recorder();
  await applyAction({ action: { type: 'set-stage', to: 'Done', close: true }, ctx: ctx({ restFn }) });
  assert.equal(sent[0].path, '/repos/o/r/issues/7/labels');
  assert.deepEqual(sent[0].body, { labels: ['in-prod'] });
  assert.equal(sent[1].method, 'DELETE');
  const patch = sent.find((c) => c.method === 'PATCH' && c.body?.state === 'closed');
  assert.equal(patch.body.state_reason, 'completed');
});

const pipelineFields = {
  stage: { id: 1, name: 'Stage', options: ['To do', 'In analysis', 'Ready', 'In progress', 'Done'] },
  blocked: { id: 2, name: 'Blocked', options: ['stalled', 'question'] },
  attempts: { id: 3, name: 'Attempts', options: [] },
};

test('set-stage to In analysis removes busy after a doorbell spec pass', async () => {
  const { sent, restFn } = recorder();
  await applyAction({
    action: { type: 'set-stage', to: 'In analysis' },
    ctx: ctx({ restFn, fields: pipelineFields }),
  });
  const removed = sent.find((c) => c.method === 'DELETE' && c.path.endsWith('/labels/busy'));
  assert.ok(removed, 'busy cleared when the stage advances');
});

test('set-stage to In progress keeps busy for delivery ack', async () => {
  const { sent, restFn } = recorder();
  await applyAction({
    action: { type: 'set-stage', to: 'In progress' },
    ctx: ctx({ restFn, fields: pipelineFields, facts: { launch: { runId: 'r1' } } }),
  });
  assert.ok(!sent.some((c) => c.method === 'DELETE' && c.path.endsWith('/labels/busy')));
});

test('set-blocked removes busy when the agent escalates or asks a question', async () => {
  const { sent, restFn } = recorder();
  await applyAction({
    action: { type: 'set-blocked', reason: 'question' },
    ctx: ctx({ restFn, fields: pipelineFields }),
  });
  assert.ok(sent.some((c) => c.method === 'DELETE' && c.path.endsWith('/labels/busy')));
});

test('dry run records the same calls but sends none', async () => {
  const { sent, restFn } = recorder();
  const result = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-bot' }, ctx: ctx({ restFn, dryRun: true }) });
  assert.deepEqual(sent, []);
  assert.ok(result.calls.length >= 2, 'dry run records comment, assign, and doorbell plan');
});

test('none with no counters sends nothing; unknown types are unsupported', async () => {
  const { sent, restFn } = recorder();
  assert.deepEqual((await applyAction({ action: { type: 'none' }, ctx: ctx({ restFn }) })).applied, []);
  assert.deepEqual((await applyAction({ action: { type: 'bogus' }, ctx: ctx({ restFn }) })).applied, ['unsupported:bogus']);
  assert.deepEqual(sent, []);
});

test('identity fails closed', async () => {
  assert.equal((await checkEngineIdentity({ token: 't', config: { engine: { logins: [] }, agents: [] } })).reason, 'no-engine-identity-configured');
  assert.equal((await checkEngineIdentity({ token: 't', config, restFn: async () => { throw new Error('x'); } })).reason, 'identity-lookup-failed');
  assert.equal((await checkEngineIdentity({ token: 't', config, restFn: async () => ({ login: 'someone' }) })).reason, 'token-not-engine-identity');
  const agentEngine = { ...config, engine: { logins: ['pawpet-bot'] } };
  assert.equal(
    (await checkEngineIdentity({ token: 't', config: agentEngine, restFn: async () => ({ login: 'pawpet-bot' }) })).reason,
    'engine-identity-matches-agent-actsAs',
  );
  const ok = await checkEngineIdentity({ token: 't', config, restFn: async () => ({ login: 'engine' }) });
  assert.equal(ok.ok, true);
  assert.equal(writesAllowed('on', ok), true);
  assert.equal(writesAllowed('dry-run', ok), false);
  assert.equal(writesAllowed('on', { ok: false }), false);
});

test('a launch or reassign write keeps the Stage and Blocked the issue already holds', async () => {
  // The issue-fields PATCH replaces the whole set; Attempts alone used to remove Stage.
  for (const action of [
    { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 1 },
    { type: 'reassign', stage: 'Ready', agent: 'pawpet-claude', attempts: 1 },
  ]) {
    const snapshot = { stage: 'Ready', blocked: 'stalled', attempts: 0 };
    const { sent, restFn } = recorder(snapshot);
    const facts = { spec: { commentId: 55, assignedTo: 'pawpet-bot', timedOut: [] } };
    await applyAction({
      action,
      ctx: ctx({ restFn, facts, parsed: { ...snapshot } }),
    });
    const patch = sent.filter((c) => c.path === '/repos/o/r/issues/7' && c.body?.issue_field_values).at(-1);
    const values = patch.body.issue_field_values;
    assert.deepEqual(values.map((v) => v.field_id).sort(), [1, 2, 3], action.type);
    assert.equal(values.find((v) => v.field_id === 1).value, 'Ready', action.type);
    assert.equal(values.find((v) => v.field_id === 2).value, 'stalled', action.type);
  }
});

test('withCurrentValues: writes win, empty and zero current values are left out', () => {
  const { withCurrentValues } = require('./issue_pipeline_v2_fields');
  assert.deepEqual(withCurrentValues({ stage: 'Ready', blocked: '', attempts: 0 }, { stage: 'Done', attempts: 0 }), { stage: 'Done', attempts: 0 });
  assert.deepEqual(withCurrentValues({ stage: '', blocked: '', attempts: 2 }, { blocked: 'stalled' }), { blocked: 'stalled', attempts: 2 });
});

test('set-stage and set-blocked field patches keep the other values the issue holds', async () => {
  const parsed = { stage: 'Ready', blocked: 'stalled', attempts: 3 };
  const { sent, restFn } = recorder(parsed);
  await applyAction({
    action: { type: 'set-stage', to: 'Done', close: false },
    ctx: ctx({ restFn, parsed: { ...parsed } }),
  });
  let patch = sent.filter((c) => c.body?.issue_field_values).at(-1);
  let values = patch.body.issue_field_values;
  assert.deepEqual(values.map((v) => v.field_id).sort(), [1, 2, 3]);
  assert.equal(values.find((v) => v.field_id === 1).value, 'Done');
  assert.equal(values.find((v) => v.field_id === 2).value, 'stalled');
  assert.equal(values.find((v) => v.field_id === 3).value, 0);

  sent.length = 0;
  const clearedBlocked = { ...parsed, blocked: '' };
  await applyAction({
    action: { type: 'set-blocked', reason: 'stalled' },
    ctx: ctx({ restFn, parsed: clearedBlocked }),
  });
  patch = sent.filter((c) => c.body?.issue_field_values).at(-1);
  values = patch.body.issue_field_values;
  assert.deepEqual(values.map((v) => v.field_id).sort(), [1, 2, 3]);
  assert.equal(values.find((v) => v.field_id === 1).value, 'Ready');
  assert.equal(values.find((v) => v.field_id === 2).value, 'stalled');
  assert.equal(values.find((v) => v.field_id === 3).value, 3);
});

test('field PATCH after launch re-reads the issue instead of the tick-start snapshot', async () => {
  const tickParsed = { stage: 'Ready', blocked: '', attempts: 0 };
  const freshParsed = { stage: 'Ready', blocked: 'stalled', attempts: 0 };
  const { sent, restFn } = recorder(() => freshParsed);
  await applyAction({
    action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 1 },
    ctx: ctx({
      restFn,
      parsed: tickParsed,
      launchFn: async () => ({ runId: 'r1', agentUrl: '' }),
    }),
  });
  const get = sent.find((c) => c.method === 'GET' && c.path === '/repos/o/r/issues/7');
  assert.ok(get, 're-reads issue before field PATCH');
  const patch = sent.filter((c) => c.body?.issue_field_values).at(-1);
  assert.equal(patch.body.issue_field_values.find((v) => v.field_id === 2).value, 'stalled');
});

test('launch: the pending record is posted before the handoff, and the run record after it', async () => {
  const { sent, restFn } = recorder(() => ({ stage: 'Ready', blocked: '', attempts: 0 }));
  const seenAtHandoff = [];
  await applyAction({
    action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 },
    ctx: ctx({
      restFn,
      launchFn: async () => {
        seenAtHandoff.push(...sent.map((c) => c.body?.body || ''));
        return { runId: 'r9', agentUrl: '' };
      },
    }),
  });
  assert.ok(seenAtHandoff.some((b) => b.includes('v2:launch-pending agent=pawpet-bot')), 'pending record before launchFn');
  const runRecord = sent.map((c) => c.body?.body || '').find((b) => b.includes('v2:launch run=r9'));
  assert.ok(runRecord, 'run record posted after the handoff');
});

test('launch: a failed record POST after a started run is never retried as a second launch', async () => {
  const { sent, restFn: base } = recorder(() => ({ stage: 'Ready', blocked: '', attempts: 0 }));
  let launches = 0;
  const restFn = async (method, path, token, body) => {
    if (method === 'POST' && path.endsWith('/comments') && String(body?.body).includes('v2:launch run=')) {
      throw new Error('comment POST failed');
    }
    return base(method, path, token, body);
  };
  await assert.rejects(
    applyAction({
      action: { type: 'launch', agent: 'pawpet-bot', method: 'PR', attempts: 0 },
      ctx: ctx({ restFn, launchFn: async () => { launches += 1; return { runId: 'r8', agentUrl: '' }; } }),
    }),
  );
  assert.equal(launches, 1, 'the run is started once; the pending record and busy label remain');
  assert.ok(sent.some((c) => String(c.body?.body).includes('v2:launch-pending')), 'pending record was written first');
});
