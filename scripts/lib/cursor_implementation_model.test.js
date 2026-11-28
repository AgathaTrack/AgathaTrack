'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  IMPLEMENTATION_MODEL,
  resolveLaunchModel,
  resolveImplementationLaunchModel,
  assertImplementationModelNotFast,
} = require('./cursor_implementation_model');

test('resolveLaunchModel: agent preferred, then env, then default', () => {
  assert.equal(resolveLaunchModel('composer-2.5', {}), IMPLEMENTATION_MODEL);
  assert.equal(resolveLaunchModel(undefined, { CURSOR_AGENT_MODEL: 'composer-2.5' }), IMPLEMENTATION_MODEL);
  assert.equal(resolveLaunchModel(undefined, {}), IMPLEMENTATION_MODEL);
  assert.equal(resolveLaunchModel('grok-4.7-medium', {}), 'grok-4.7-medium');
});

test('assertImplementationModelNotFast rejects fast ids', () => {
  assert.throws(() => assertImplementationModelNotFast('composer-2.5-fast'), /refusing Cursor launch/);
  assert.doesNotThrow(() => assertImplementationModelNotFast('composer-2.5'));
});

test('resolveImplementationLaunchModel refuses fast override from env', () => {
  const prior = process.env.CURSOR_AGENT_MODEL;
  process.env.CURSOR_AGENT_MODEL = 'composer-2.5-fast';
  try {
    assert.throws(() => resolveImplementationLaunchModel(undefined), /refusing Cursor launch/);
  } finally {
    if (prior === undefined) {
      delete process.env.CURSOR_AGENT_MODEL;
    } else {
      process.env.CURSOR_AGENT_MODEL = prior;
    }
  }
});

test('committed pipeline-agents and execute-plan.config use IMPLEMENTATION_MODEL for tier-a cursor', () => {
  const root = path.join(__dirname, '..', '..');
  const pipeline = JSON.parse(fs.readFileSync(path.join(root, '.github', 'pipeline-agents.json'), 'utf8'));
  const executePlan = JSON.parse(fs.readFileSync(path.join(root, '.github', 'execute-plan.config.json'), 'utf8'));
  const cursorA = (pipeline.agents || []).find((a) => a.id === 'cursor-a');
  assert.ok(cursorA, 'cursor-a present');
  assert.equal(cursorA.model, IMPLEMENTATION_MODEL);
  assert.equal(executePlan.cursor_model_implement, IMPLEMENTATION_MODEL);
  assert.equal(executePlan.cursor_model_fix, IMPLEMENTATION_MODEL);
});