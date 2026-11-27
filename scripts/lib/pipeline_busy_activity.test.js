'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasLivePipelineActivity,
  idleThresholdHoursForIssue,
  isFresh,
} = require('./pipeline_busy_activity');
const { loadConfig } = require('../issue_pipeline_v2_config');

const NOW = Date.parse('2026-11-24T12:00:00Z');
const ENGINE = ['pawpet-engine'];
const LIMITS = { stalledInactivityHours: 24, ackWindowMin: 15 };

function comment(id, body, created_at, login = 'pawpet-engine') {
  return { id, body, created_at, updated_at: created_at, user: { login } };
}

test('hasLivePipelineActivity: active trusted run marker within freshness window', () => {
  const comments = [
    comment(
      1,
      '<!-- cursor-agent-run: {"status":"running","runId":"r1"} -->',
      '2026-11-24T11:00:00Z',
      'pawpet-bot',
    ),
  ];
  assert.equal(
    hasLivePipelineActivity({
      comments,
      now: NOW,
      limits: LIMITS,
      engineLogins: ENGINE,
      issueIsBusy: true,
    }),
    true,
  );
});

test('hasLivePipelineActivity: stale active marker does not suppress', () => {
  const comments = [
    comment(
      1,
      '<!-- cursor-agent-run: {"status":"running","runId":"r1"} -->',
      '2026-11-22T00:00:00Z',
      'pawpet-bot',
    ),
  ];
  assert.equal(
    hasLivePipelineActivity({
      comments,
      now: NOW,
      limits: LIMITS,
      engineLogins: ENGINE,
      issueIsBusy: true,
    }),
    false,
  );
});

test('hasLivePipelineActivity: fresh launch-pending suppresses', () => {
  const comments = [
    comment(
      1,
      '<!-- v2:launch-pending agent=cursor-a purpose=doorbell -->\nLaunching',
      '2026-11-24T08:00:00Z',
    ),
  ];
  assert.equal(
    hasLivePipelineActivity({
      comments,
      now: NOW,
      limits: LIMITS,
      engineLogins: ENGINE,
      issueIsBusy: true,
    }),
    true,
  );
});

test('hasLivePipelineActivity: launch-acked within ack window suppresses', () => {
  const comments = [
    comment(
      1,
      '<!-- v2:launch-acked run=r1 -->\nWorking',
      '2026-11-24T11:50:00Z',
    ),
  ];
  assert.equal(
    hasLivePipelineActivity({
      comments,
      now: NOW,
      limits: LIMITS,
      engineLogins: ENGINE,
      issueIsBusy: true,
    }),
    true,
  );
});

test('hasLivePipelineActivity: doorbell launch in flight when busy and fresh', () => {
  const comments = [
    comment(
      1,
      '<!-- v2:launch run=r1 agent=cursor-a purpose=doorbell stage=To do -->\nStarted',
      '2026-11-24T10:00:00Z',
    ),
  ];
  assert.equal(
    hasLivePipelineActivity({
      comments,
      now: NOW,
      limits: LIMITS,
      engineLogins: ENGINE,
      issueIsBusy: true,
    }),
    true,
  );
});

test('idleThresholdHoursForIssue uses config default and override', () => {
  const config = loadConfig();
  assert.equal(
    idleThresholdHoursForIssue({ body: '### Delivery plan\n\nMethod: PR\n', config, overrideHours: null }),
    config.limits.stalledInactivityHours,
  );
  assert.equal(
    idleThresholdHoursForIssue({ body: '', config, overrideHours: 2 }),
    2,
  );
});

test('isFresh boundary', () => {
  const window = 24 * 60 * 60 * 1000;
  assert.equal(isFresh(NOW - window + 1, NOW, window), true);
  assert.equal(isFresh(NOW - window, NOW, window), false);
});