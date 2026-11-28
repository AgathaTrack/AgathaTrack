'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectModelHints, auditCursorLaunchModel } = require('./cursor_launch_model_audit_lib');

test('collectModelHints finds nested model ids', () => {
  const hints = collectModelHints({
    status: 'RUNNING',
    agent: { model: { id: 'composer-2.5' } },
    config: { modelId: 'composer-2.5-fast' },
  });
  assert.equal(hints['agent.model'], 'composer-2.5');
  assert.equal(hints['config.modelId'], 'composer-2.5-fast');
});

test('auditCursorLaunchModel merges agent and run hints', async () => {
  const fetchFn = async (url) => {
    if (url.endsWith('/v1/agents/bc-a')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 'bc-a', model: { id: 'composer-2.5' } }),
      };
    }
    if (url.endsWith('/runs/run-1')) {
      return {
        ok: true,
        text: async () => JSON.stringify({ status: 'RUNNING', run: { modelName: 'Composer 2.5 fast' } }),
      };
    }
    throw new Error(`unexpected ${url}`);
  };
  const report = await auditCursorLaunchModel({
    apiKey: 'k',
    agentId: 'bc-a',
    runId: 'run-1',
    base: 'https://api.cursor.com',
    fetchFn,
  });
  assert.equal(report.servedModelAvailable, true);
  assert.equal(report.modelHints.model, 'composer-2.5');
  assert.equal(report.modelHints['run.modelName'], 'Composer 2.5 fast');
});

test('auditCursorLaunchModel exit path when no model fields', async () => {
  const fetchFn = async () => ({
    ok: true,
    text: async () => JSON.stringify({ status: 'FINISHED' }),
  });
  const report = await auditCursorLaunchModel({
    apiKey: 'k',
    agentId: 'bc-a',
    runId: 'run-1',
    base: 'https://api.cursor.com',
    fetchFn,
  });
  assert.equal(report.servedModelAvailable, false);
  assert.match(report.note, /No model fields/);
});