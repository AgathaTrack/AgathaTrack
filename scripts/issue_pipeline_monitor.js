'use strict';

const { monitorIssue } = require('../.github/scripts/monitor-cursor-agent');

const MONITOR_MARKER = '<!-- pipeline-monitor -->';

/**
 * Poll Cursor run for one in-progress pipeline issue (reuses agent-monitor.js).
 */
async function applyMonitorTick({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  dryRun,
}) {
  const apiKey = process.env.cursor_api_key || process.env.CURSOR_API_KEY;
  const stubOk = process.env.PIPELINE_MONITOR_STUB === 'true';

  if (dryRun) {
    return {
      dryRun: true,
      action: 'monitor',
      issueNumber,
      stubOk,
    };
  }

  if (!apiKey && !stubOk) {
    return {
      action: 'monitor',
      issueNumber,
      skipped: true,
      reason: 'missing-cursor-api-key',
    };
  }

  if (stubOk && !apiKey) {
    return {
      action: 'monitor',
      issueNumber,
      skipped: true,
      reason: 'stub-marker-no-api',
    };
  }

  const result = await monitorIssue({
    owner,
    repo,
    issueNumber,
    token,
    apiKey,
    projectsPat,
    projectId,
    statusFieldId,
  });

  return { action: 'monitor', ...result };
}

module.exports = {
  MONITOR_MARKER,
  applyMonitorTick,
};