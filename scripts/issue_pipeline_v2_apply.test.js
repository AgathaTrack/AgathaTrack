'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAction, doorbellAssignees } = require('./issue_pipeline_v2_apply');
const { checkEngineIdentity, writesAllowed } = require('./issue_pipeline_v2_identity');

const config = {
  agents: [
    { login: 'pawpet-bot', methods: ['PR'] },
    { login: 'pawpet-claude', methods: ['PR'] },
  ],
  engine: { logins: ['engine'] },
};
const fields = {
  stage: { id: 1, name: 'Stage', options: ['Ready', 'Done'] },
  blocked: { id: 2, name: 'Blocked', options: ['stalled'] },
  attempts: { id: 3, name: 'Attempts', options: [] },
  totalN: { id: 4, name: 'Total N', options: [] },
};

function ctx(extra = {}) {
  return {
    owner: 'o', repo: 'r', issueNumber: 7, token: 'pat', config, fields,
    parsed: { attempts: 0, totalN: 0 }, assignees: ['human', 'pawpet-bot'], counters: {}, facts: {},
    dryRun: false, ...extra,
  };
}

function recorder() {
  const sent = [];
  return { sent, restFn: async (method, path, token, body) => { sent.push({ method, path, token, body }); return { id: 1 }; } };
}

test('doorbell keeps humans and replaces agents', () => {
  assert.deepEqual(doorbellAssignees(['human', 'pawpet-bot'], 'pawpet-claude', config), ['human', 'pawpet-claude']);
  assert.deepEqual(doorbellAssignees(undefined, 'pawpet-bot', config), ['pawpet-bot']);
});

test('request-spec posts the marker comment then rings the agent', async () => {
  const { sent, restFn } = recorder();
  const result = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-claude' }, ctx: ctx({ restFn }) });
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].path, '/repos/o/r/issues/7/comments');
  assert.match(sent[0].body.body, /v2:spec-request/);
  assert.equal(sent[1].method, 'PATCH');
  assert.deepEqual(sent[1].body.assignees, ['human', 'pawpet-claude']);
  assert.deepEqual(result.applied, ['comment:spec-request', 'assign:pawpet-claude']);
});

test('request-spec also starts a Cursor run for an agent whose runner the engine can launch', async () => {
  const { restFn } = recorder();
  const launches = [];
  const withRunners = { ...config, launchRunners: ['cursor'], agents: [
    { login: 'pawpet-bot', runner: 'cursor', methods: ['PR'] },
    { login: 'pawpet-claude', runner: 'claude', methods: ['PR'] },
  ] };
  const launchFn = async (args) => { launches.push(args); return { runId: 'r' }; };
  const bot = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-bot' }, ctx: ctx({ restFn, launchFn, config: withRunners }) });
  assert.deepEqual(launches, [{ agent: 'pawpet-bot', stage: 'To do' }]);
  assert.ok(bot.applied.includes('doorbell:pawpet-bot'));
  const claude = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-claude' }, ctx: ctx({ restFn, launchFn, config: withRunners }) });
  assert.equal(launches.length, 1, 'a runner the engine cannot start is only assigned');
  assert.ok(!claude.applied.some((entry) => entry.startsWith('doorbell')));
  const dry = await applyAction({ action: { type: 'request-review', agent: 'pawpet-bot', hash: 'h' }, ctx: ctx({ restFn, launchFn, config: withRunners, dryRun: true }) });
  assert.equal(launches.length, 1, 'a dry run sends nothing');
  assert.ok(dry.calls.some((call) => call.path === 'cursor:/v1/agents' && call.body.stage === 'In analysis'));
});

test('a failed doorbell launch never fails the tick', async () => {
  const { restFn } = recorder();
  const withRunners = { ...config, launchRunners: ['cursor'], agents: [{ login: 'pawpet-bot', runner: 'cursor', methods: ['PR'] }] };
  const result = await applyAction({
    action: { type: 'request-spec', agent: 'pawpet-bot' },
    ctx: ctx({ restFn, config: withRunners, launchFn: async () => { throw new Error('cursor down'); } }),
  });
  assert.ok(result.applied.includes('doorbell-failed:pawpet-bot'));
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
  assert.equal(sent[2].body.state, 'closed');
  assert.equal(sent[2].body.state_reason, 'completed');
});

test('dry run records the same calls but sends none', async () => {
  const { sent, restFn } = recorder();
  const result = await applyAction({ action: { type: 'request-spec', agent: 'pawpet-bot' }, ctx: ctx({ restFn, dryRun: true }) });
  assert.deepEqual(sent, []);
  assert.equal(result.calls.length, 2);
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
  assert.equal((await checkEngineIdentity({ token: 't', config: agentEngine, restFn: async () => ({ login: 'pawpet-bot' }) })).reason, 'engine-identity-is-a-listed-agent');
  const ok = await checkEngineIdentity({ token: 't', config, restFn: async () => ({ login: 'engine' }) });
  assert.equal(ok.ok, true);
  assert.equal(writesAllowed('on', ok), true);
  assert.equal(writesAllowed('dry-run', ok), false);
  assert.equal(writesAllowed('on', { ok: false }), false);
});
