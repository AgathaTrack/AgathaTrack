'use strict';

const fs = require('node:fs');

const DEFAULT_SCHEDULE_STALE_MS = 2 * 60 * 60 * 1000;
const DISPATCHER_WORKFLOW_FILE = 'issue-pipeline-dispatcher.yml';

/**
 * Count open pipeline issues by Pawpet Status (integration repair #2363 §6.2).
 */
function countByColumn(issues) {
  const counts = Object.create(null);
  for (const row of issues || []) {
    const status = row.status || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

/**
 * True when the last completed schedule heartbeat is older than maxGapMs (default 2h).
 */
function isScheduleHeartbeatStale(lastCompletedScheduleMs, nowMs, maxGapMs = DEFAULT_SCHEDULE_STALE_MS) {
  if (lastCompletedScheduleMs == null || !Number.isFinite(lastCompletedScheduleMs)) {
    return null;
  }
  const gap = nowMs - lastCompletedScheduleMs;
  return gap > maxGapMs;
}

function summarizePlannedActions(actions) {
  const byAction = Object.create(null);
  for (const row of actions || []) {
    const key = row.action || 'unknown';
    byAction[key] = (byAction[key] || 0) + 1;
  }
  return byAction;
}

function buildHealthPayload({
  mode,
  dryRun,
  eventName,
  at,
  byColumn,
  issueCount,
  wipInUse,
  wipMax,
  actions,
  executed,
  errors,
  schedule,
}) {
  return {
    event: 'pipeline_health',
    at,
    event_name: eventName || null,
    mode,
    dry_run: Boolean(dryRun),
    issue_count: issueCount ?? 0,
    by_column: byColumn || {},
    wip_in_use: wipInUse ?? 0,
    wip_max: wipMax ?? null,
    planned_action_count: (actions || []).length,
    planned_by_action: summarizePlannedActions(actions),
    executed_count: (executed || []).length,
    errors: errors || [],
    schedule: schedule || null,
  };
}

function formatHealthStepSummary(payload) {
  const lines = [
    '## Issue pipeline health',
    '',
    `- Mode: **${payload.mode}** (dry_run=${payload.dry_run})`,
    `- Issues on board: **${payload.issue_count}**`,
    `- WIP: **${payload.wip_in_use}** / ${payload.wip_max}`,
    `- Planned actions this tick: **${payload.planned_action_count}**`,
    `- Executed: **${payload.executed_count}**`,
  ];
  if (payload.schedule?.stale === true) {
    lines.push(
      '',
      `> Schedule heartbeat stale: last completed schedule tick was **${payload.schedule.gap_minutes}** min ago (threshold ${payload.schedule.threshold_minutes} min).`,
    );
  }
  if (Object.keys(payload.by_column).length) {
    lines.push('', '### By column', '');
    for (const [status, count] of Object.entries(payload.by_column).sort()) {
      lines.push(`- ${status}: ${count}`);
    }
  }
  if (payload.errors.length) {
    lines.push('', '### Errors', '');
    for (const err of payload.errors) {
      lines.push(`- #${err.issue}: ${err.message}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

async function fetchLastCompletedScheduleMs(owner, repo, token, io = {}) {
  const fetchFn = io.fetch || global.fetch;
  if (!fetchFn || !token) {
    return null;
  }
  const url =
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/` +
    `${DISPATCHER_WORKFLOW_FILE}/runs?event=schedule&status=completed&per_page=3`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    return null;
  }
  const data = await res.json();
  const runs = data.workflow_runs || [];
  const completed = runs.filter((r) => r.status === 'completed');
  if (!completed.length) {
    return null;
  }
  const ts = Date.parse(completed[0].updated_at);
  return Number.isFinite(ts) ? ts : null;
}

async function buildScheduleHealth(owner, repo, token, nowMs, io = {}) {
  const lastMs = await fetchLastCompletedScheduleMs(owner, repo, token, io);
  const stale = isScheduleHeartbeatStale(lastMs, nowMs);
  if (lastMs == null) {
    return { last_completed_at: null, stale: null, gap_ms: null };
  }
  const gapMs = nowMs - lastMs;
  return {
    last_completed_at: new Date(lastMs).toISOString(),
    stale,
    gap_ms: gapMs,
    gap_minutes: Math.round(gapMs / 60000),
    threshold_minutes: Math.round(DEFAULT_SCHEDULE_STALE_MS / 60000),
  };
}

function emitHealthReport(payload, io = {}) {
  console.log(JSON.stringify(payload));
  const summaryPath = io.stepSummaryPath ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    fs.appendFileSync(summaryPath, `${formatHealthStepSummary(payload)}\n`);
  }
}

module.exports = {
  DEFAULT_SCHEDULE_STALE_MS,
  countByColumn,
  isScheduleHeartbeatStale,
  summarizePlannedActions,
  buildHealthPayload,
  formatHealthStepSummary,
  fetchLastCompletedScheduleMs,
  buildScheduleHealth,
  emitHealthReport,
};