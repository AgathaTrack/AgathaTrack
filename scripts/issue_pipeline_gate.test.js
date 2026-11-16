'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isDispatcherEligibleIssue,
  isExecutePlanControlTitle,
} = require('./issue_pipeline_gate');

test('isExecutePlanControlTitle', () => {
  assert.equal(isExecutePlanControlTitle('[execute-plan] foo'), true);
  assert.equal(isExecutePlanControlTitle('execute-plan: bar'), true);
  assert.equal(isExecutePlanControlTitle('light-plan: bar'), false);
});

test('isDispatcherEligibleIssue excludes owner-programme and control issues', () => {
  const base = {
    title: 'Bug',
    status: 'To do',
    labels: ['pipeline-beta'],
  };
  assert.equal(isDispatcherEligibleIssue(base, 'on'), true);
  assert.equal(
    isDispatcherEligibleIssue({ ...base, labels: ['pipeline-beta', 'owner-programme'] }, 'on'),
    false,
  );
  assert.equal(
    isDispatcherEligibleIssue({ ...base, title: '[execute-plan] x' }, 'on'),
    false,
  );
  assert.equal(
    isDispatcherEligibleIssue({ ...base, status: 'Backlog' }, 'on'),
    false,
  );
});