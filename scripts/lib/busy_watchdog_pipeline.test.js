'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../issue_pipeline_v2_config');
const { buildLaunchPending, buildLaunchAcked } = require('../issue_pipeline_v2_launch');
const { buildRunMarker } = require('../../.github/scripts/agent-payload-lib');
const { hasLivePipelineActivity } = require('./busy_watchdog_pipeline');

const config = loadConfig();
const ENGINE = config.engine.logins;
const LIMITS = config.limits;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000).toISOString();

function engineComment(body, created_at) {
  return { user: { login: ENGINE[0] }, body, created_at, updated_at: created_at };
}

function botRunComment(status, hAgo) {
  const ts = hoursAgo(hAgo);
  return {
    user: { login: 'pawpet-bot' },
    body: buildRunMarker({ agentId: 'bc-1', runId: 'run-1', status }),
    created_at: ts,
    updated_at: ts,
  };
}

test('hasLivePipelineActivity: fresh running marker suppresses', () => {
  const comments = [botRunComment('running', 1)];
  assert.equal(
    hasLivePipelineActivity({ comments, engineLogins: ENGINE, busy: true, now: NOW, limits: LIMITS }),
    true,
  );
});

test('hasLivePipelineActivity: stale running marker does not suppress', () => {
  const comments = [botRunComment('running', LIMITS.stalledInactivityHours + 1)];
  assert.equal(
    hasLivePipelineActivity({ comments, engineLogins: ENGINE, busy: true, now: NOW, limits: LIMITS }),
    false,
  );
});

test('hasLivePipelineActivity: launch-pending suppresses when fresh', () => {
  const body = buildLaunchPending({ agent: 'pawpet-bot', purpose: 'delivery' });
  const comments = [engineComment(body, hoursAgo(2))];
  assert.equal(
    hasLivePipelineActivity({ comments, engineLogins: ENGINE, busy: true, now: NOW, limits: LIMITS }),
    true,
  );
});

test('hasLivePipelineActivity: launch-pending flags when older than stalledInactivityHours', () => {
  const body = buildLaunchPending({ agent: 'pawpet-bot', purpose: 'doorbell' });
  const comments = [engineComment(body, hoursAgo(LIMITS.stalledInactivityHours + 2))];
  assert.equal(
    hasLivePipelineActivity({ comments, engineLogins: ENGINE, busy: true, now: NOW, limits: LIMITS }),
    false,
  );
});

test('hasLivePipelineActivity: recent launch-acked within ack window suppresses', () => {
  const body = buildLaunchAcked({ runId: 'r1' });
  const comments = [engineComment(body, hoursAgo(0.1))];
  assert.equal(
    hasLivePipelineActivity({ comments, engineLogins: ENGINE, busy: true, now: NOW, limits: LIMITS }),
    true,
  );
});

test('hasLivePipelineActivity: launch-acked past ack window but fresh marker still suppresses', () => {
  const ackBody = buildLaunchAcked({ runId: 'r1' });
  const comments = [engineComment(ackBody, hoursAgo(1)), botRunComment('running', 0.5)];
  assert.equal(
    hasLivePipelineActivity({ comments, engineLogins: ENGINE, busy: true, now: NOW, limits: LIMITS }),
    true,
  );
});