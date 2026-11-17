'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateNonPlanForbidden,
  nonPlanInfrastructureOutcome,
} = require('../lib/execute_plan_scope_nonplan');

test('nonPlanInfrastructureOutcome enforce fails closed', () => {
  const out = nonPlanInfrastructureOutcome('file list', new Error('boom'), 'enforce');
  assert.deepEqual([out.conclusion, out.title], ['failure', 'error']);
});

test('nonPlanInfrastructureOutcome report-only stays green', () => {
  const out = nonPlanInfrastructureOutcome('config', new Error('missing'), 'report-only');
  assert.deepEqual([out.conclusion, out.title], ['success', 'error-advisory']);
});

test('evaluateNonPlanForbidden owner ack clears violations', () => {
  const ack = { id: 1, state: 'APPROVED', commit_id: 'sha', user: { login: 'KanopeeKa' } };
  const ev = evaluateNonPlanForbidden({
    files: ['db/migrations/a.sql'],
    scopeAckReview: ack,
    mode: 'enforce',
    owners: ['KanopeeKa'],
  });
  assert.deepEqual([ev.conclusion, ev.title], ['success', 'ok']);
  assert.match(ev.summary, /owner-approved/);
});