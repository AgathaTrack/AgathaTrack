'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateTodoLaneTriage } = require('./issue_pipeline_triage');
const { isPipelineIssue } = require('./issue_pipeline_gate');

test('evaluateTodoLaneTriage passes when only risky scope is present', () => {
  const result = evaluateTodoLaneTriage({
    title: 'Add auth billing API key migration',
    body: `### Summary\n${'x'.repeat(90)}\n\n### Objective\n${'y'.repeat(20)}\n\n### Scope\n${'z'.repeat(20)}\n\n### Definition of Done\n${'d'.repeat(20)}`,
    labels: ['task'],
  });
  assert.equal(result.decision, 'pass');
  assert.ok(result.hints.length > 0);
});

test('isPipelineIssue requires pipeline-beta when mode off', () => {
  assert.equal(isPipelineIssue(['task'], 'off'), false);
  assert.equal(isPipelineIssue(['task', 'pipeline-beta'], 'off'), true);
  assert.equal(isPipelineIssue(['task'], 'on'), true);
});