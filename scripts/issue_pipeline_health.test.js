'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  countByColumn,
  isScheduleHeartbeatStale,
  summarizePlannedActions,
  buildHealthPayload,
  formatHealthStepSummary,
} = require('./issue_pipeline_health');

test('countByColumn groups pipeline issues', () => {
  const issues = [
    { status: 'Ready', number: 1 },
    { status: 'Ready', number: 2 },
    { status: 'In Analysis', number: 3 },
  ];
  assert.equal(countByColumn(issues).Ready, 2);
  assert.equal(countByColumn(issues)['In Analysis'], 1);
});

test('isScheduleHeartbeatStale when gap exceeds threshold', () => {
  const now = Date.parse('2026-11-16T14:00:00Z');
  const last = Date.parse('2026-11-16T11:00:00Z');
  assert.equal(isScheduleHeartbeatStale(last, now, 2 * 60 * 60 * 1000), true);
  assert.equal(isScheduleHeartbeatStale(last, now, 4 * 60 * 60 * 1000), false);
});

test('isScheduleHeartbeatStale returns null without prior run', () => {
  assert.equal(isScheduleHeartbeatStale(null, Date.now()), null);
});

test('summarizePlannedActions counts by action id', () => {
  const out = summarizePlannedActions([
    { action: 'review' },
    { action: 'review' },
    { action: 'monitor' },
  ]);
  assert.equal(out.review, 2);
  assert.equal(out.monitor, 1);
});

test('buildHealthPayload includes schedule block', () => {
  const payload = buildHealthPayload({
    mode: 'dry-run',
    dryRun: true,
    eventName: 'schedule',
    at: '2026-11-16T14:00:00Z',
    byColumn: { Ready: 1 },
    issueCount: 1,
    wipInUse: 0,
    wipMax: 2,
    actions: [{ action: 'delivery' }],
    executed: [],
    errors: [],
    schedule: { stale: false, gap_minutes: 30 },
  });
  assert.equal(payload.event, 'pipeline_health');
  assert.equal(payload.planned_action_count, 1);
  assert.equal(payload.schedule.gap_minutes, 30);
});

test('formatHealthStepSummary marks stale schedule', () => {
  const md = formatHealthStepSummary({
    mode: 'on',
    dry_run: false,
    issue_count: 3,
    wip_in_use: 1,
    wip_max: 2,
    planned_action_count: 0,
    executed_count: 0,
    by_column: {},
    errors: [],
    schedule: { stale: true, gap_minutes: 150, threshold_minutes: 120 },
  });
  assert.match(md, /Schedule heartbeat stale/);
});