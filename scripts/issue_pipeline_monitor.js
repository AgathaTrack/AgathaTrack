'use strict';

const {
  fetchIssue,
  fetchAllIssueComments,
  assignIssue,
  setLabels,
  setIssueAssignees,
  updateProjectStatus,
} = require('../.github/scripts/github-project-lib');
const { parseRunMarker } = require('../.github/scripts/agent-payload-lib');
const { monitorIssue } = require('../.github/scripts/monitor-cursor-agent');
const OWNER_LOGIN = 'KanopeeKa';

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

  const comments = await fetchAllIssueComments(owner, repo, issueNumber, token);
  let runMarker = null;
  for (const comment of comments) {
    const parsed = parseRunMarker(comment.body);
    if (parsed) {
      runMarker = parsed;
      break;
    }
  }
  if (
    runMarker &&
    (runMarker.stub ||
      runMarker.agentId === 'pipeline-stub' ||
      runMarker.runId === 'pipeline-stub')
  ) {
    const assignToken = process.env.EXECUTE_PLAN_BOT_TOKEN;
    await setLabels(owner, repo, issueNumber, ['needs-owner'], ['busy'], token);
    await setIssueAssignees(owner, repo, issueNumber, [], assignToken || token);
    await assignIssue(owner, repo, issueNumber, OWNER_LOGIN, assignToken || token);
    if (projectsPat && projectId && statusFieldId) {
      const refreshed = await fetchIssue(owner, repo, issueNumber, token);
      await updateProjectStatus({
        issue: refreshed,
        projectId,
        statusFieldId,
        statusName: 'Ready',
        projectsPat,
      });
    }
    return {
      action: 'monitor',
      issueNumber,
      released: true,
      reason: 'stale-pipeline-stub-run',
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