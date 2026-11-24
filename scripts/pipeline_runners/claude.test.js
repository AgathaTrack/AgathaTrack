'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { launch, status, countActiveClaudeRuns, WORKFLOW_FILE } = require('./claude');

test('claude runner dispatches pipeline-claude-run with public inputs only', async () => {
  const calls = [];
  const config = { limits: { runnerWip: { claude: 1 } } };
  await launch({
    agent: { id: 'claude-a' },
    issue: { number: 42 },
    owner: 'o',
    repo: 'r',
    stage: 'To do',
    method: 'PR',
    nonce: 'abc123',
    config,
    deps: {
      restFn: async (method, path, token, body) => {
        if (path.includes('/runs?')) {
          return { workflow_runs: [] };
        }
        calls.push({ method, path, body });
        return {};
      },
      dispatchToken: 'pat',
      randomRef: () => 'ref1',
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].path, new RegExp(`/actions/workflows/${WORKFLOW_FILE}/dispatches`));
  assert.deepEqual(calls[0].body.inputs, {
    issue: '42',
    stage: 'To do',
    agent_id: 'claude-a',
    method: 'PR',
    nonce: 'abc123',
    run_ref: 'ref1',
  });
});

test('the run id and the run name use the public reference, never the nonce (PIPE-V2-D-REV3-011)', async () => {
  const config = { limits: { runnerWip: { claude: 3 } } };
  const out = await launch({
    agent: { id: 'claude-a' }, issue: { number: 1 }, owner: 'o', repo: 'r', stage: 'To do', method: 'PR',
    nonce: 'secretnonce', config,
    deps: { restFn: async (m, path) => (path.includes('/runs?') ? { workflow_runs: [] } : {}), dispatchToken: 't', randomRef: () => 'ref9' },
  });
  assert.equal(out.runId, 'claude:ref9');
  assert.equal(out.runId.includes('secretnonce'), false);
});

test('launch at runner WIP cap throws RUNNER_QUEUED', async () => {
  const config = { limits: { runnerWip: { claude: 1 } } };
  const runs = { workflow_runs: [{ status: 'in_progress' }] };
  const restFn = async (method, path) => {
    if (path.includes('/runs?')) return runs;
    return {};
  };
  await assert.rejects(
    () =>
      launch({
        agent: { id: 'claude-a' },
        issue: { number: 1 },
        owner: 'o',
        repo: 'r',
        stage: 'To do',
        method: 'PR',
        nonce: 'n',
        config,
        deps: { restFn, dispatchToken: 't' },
      }),
    (error) => error.code === 'RUNNER_QUEUED',
  );
});

test('delivery launch dispatches In progress with the delivery method prompt path', async () => {
  const calls = [];
  const config = { limits: { runnerWip: { claude: 3 } } };
  await launch({
    agent: { id: 'claude-a' },
    issue: { number: 9 },
    owner: 'o',
    repo: 'r',
    method: 'light-plan',
    purpose: 'delivery',
    nonce: 'deliverynonce',
    config,
    deps: {
      restFn: async (method, path, token, body) => {
        if (path.includes('/runs?')) return { workflow_runs: [] };
        calls.push({ method, path, body });
        return {};
      },
      dispatchToken: 'pat',
      randomRef: () => 'del1',
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.inputs.stage, 'In progress');
  assert.equal(calls[0].body.inputs.method, 'light-plan');
});

test('claude status maps workflow conclusion', async () => {
  const runs = {
    workflow_runs: [
      { name: 'pipeline-claude-ref1', status: 'completed', conclusion: 'failure' },
      { name: 'pipeline-claude-ref2', status: 'completed', conclusion: 'success' },
      { name: 'pipeline-claude-ref3', status: 'in_progress', conclusion: null },
    ],
  };
  const restFn = async () => runs;
  assert.equal(await status({ runId: 'claude:ref1', owner: 'o', repo: 'r', deps: { restFn } }), 'failed');
  assert.equal(await status({ runId: 'claude:ref2', owner: 'o', repo: 'r', deps: { restFn } }), 'finished');
  assert.equal(await status({ runId: 'claude:ref3', owner: 'o', repo: 'r', deps: { restFn } }), 'running');
  assert.equal(await status({ runId: 'cursor-run', owner: 'o', repo: 'r', deps: { restFn } }), 'running', 'not a Claude run id');
  assert.equal(await countActiveClaudeRuns({ owner: 'o', repo: 'r', deps: { restFn } }), 1);
});

test('claude launch without a nonce is refused before any dispatch', async () => {
  const calls = [];
  await assert.rejects(
    launch({
      agent: { id: 'claude-a' }, issue: { number: 1 }, owner: 'o', repo: 'r', stage: 'acceptance', method: 'PR',
      nonce: undefined, purpose: 'doorbell', config: { limits: { runnerWip: { claude: 3 } } },
      deps: { restFn: async (m, path, t, body) => { calls.push({ m, path, body }); return {}; }, dispatchToken: 't' },
    }),
    /claude launch requires nonce/,
  );
  assert.equal(calls.length, 0);
});
