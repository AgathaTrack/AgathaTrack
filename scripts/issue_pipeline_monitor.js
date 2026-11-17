'use strict';

const {
  fetchIssue,
  fetchAllIssueComments,
  assignIssue,
  setLabels,
  updateProjectStatus,
} = require('../.github/scripts/github-project-lib');
const { findTrustedRunMarker, isStubRunMarker } = require('./lib/pipeline_run_marker');
const { monitorIssue } = require('../.github/scripts/monitor-cursor-agent');
const { applyLightPlanRelaunch } = require('./issue_pipeline_light_plan_relaunch');
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
  const found = findTrustedRunMarker(comments);
  // #2363 §4.3: a placeholder run, or no run at all, must not hold a WIP slot.
  const staleReason = !found
    ? 'missing-run-marker'
    : isStubRunMarker(found.marker)
      ? 'stale-pipeline-stub-run'
      : null;
  if (staleReason) {
    const assignToken = process.env.EXECUTE_PLAN_BOT_TOKEN;
    await setLabels(owner, repo, issueNumber, ['needs-owner'], ['busy'], token);
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
      reason: staleReason,
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
    found,
  });

  if (result.action === 'light-plan-resume') {
    const assignToken = process.env.EXECUTE_PLAN_BOT_TOKEN;
    if (!assignToken) {
      return {
        action: 'monitor',
        lightPlanResume: true,
        skipped: true,
        reason: 'missing-bot-token',
        monitor: result,
      };
    }
    const relaunch = await applyLightPlanRelaunch({
      owner,
      repo,
      issueNumber,
      token,
      assignToken,
      dryRun: false,
    });
    return { action: 'monitor', lightPlanResume: true, monitor: result, ...relaunch };
  }

  return { action: 'monitor', ...result };
}

module.exports = {
  MONITOR_MARKER,
  applyMonitorTick,
};