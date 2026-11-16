'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePipelineMode,
  pipelineModeAllowsRun,
  pipelineModeWritesLive,
} = require('./issue_pipeline_mode');

test('resolvePipelineMode', () => {
  assert.equal(resolvePipelineMode(undefined), 'off');
  assert.equal(resolvePipelineMode('dry-run'), 'dry-run');
  assert.equal(resolvePipelineMode('ON'), 'on');
  assert.equal(resolvePipelineMode('bogus'), 'off');
});

test('pipelineModeAllowsRun and writes', () => {
  assert.equal(pipelineModeAllowsRun('off'), false);
  assert.equal(pipelineModeAllowsRun('dry-run'), true);
  assert.equal(pipelineModeWritesLive('dry-run'), false);
  assert.equal(pipelineModeWritesLive('on'), true);
});