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
  });
});

test('claude status maps workflow conclusion', async () => {
  const runs = {
    workflow_runs: [
      { name: 'pipeline-claude-nonce1', status: 'completed', conclusion: 'failure' },
      { name: 'pipeline-claude-nonce2', status: 'completed', conclusion: 'success' },
      { name: 'pipeline-claude-nonce3', status: 'in_progress', conclusion: null },
    ],
  };
  const restFn = async () => runs;
  assert.equal(await status({ nonce: 'nonce1', owner: 'o', repo: 'r', deps: { restFn } }), 'failed');
  assert.equal(await status({ nonce: 'nonce2', owner: 'o', repo: 'r', deps: { restFn } }), 'finished');
  assert.equal(await status({ nonce: 'nonce3', owner: 'o', repo: 'r', deps: { restFn } }), 'running');
  assert.equal(await countActiveClaudeRuns({ owner: 'o', repo: 'r', deps: { restFn } }), 1);
});