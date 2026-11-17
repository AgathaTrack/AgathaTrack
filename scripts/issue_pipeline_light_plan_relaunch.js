'use strict';

const {
  fetchIssue,
  assignIssue,
  setLabels,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const { buildDispatchComment } = require('../.github/scripts/agent-payload-lib');
const { launchAgent, botLaunchEnvVars } = require('../.github/scripts/launch-cursor-agent');
const { buildLightPlanContinuePrompt } = require('./issue_pipeline_implement');
const { loadIssueState, upsertPipelineState } = require('./issue_pipeline_state_load');
const OWNER_LOGIN = 'KanopeeKa';
const RUN_MARKER_PREFIX = '<!-- cursor-agent-run:';
const RELAUNCH_MARKER = '<!-- pipeline-light-plan-relaunch -->';

const DEFAULT_STUCK_LIMIT = 3;

function stuckLimit(env = process.env) {
  const raw = Number(env.PIPELINE_STUCK_MAX || DEFAULT_STUCK_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STUCK_LIMIT;
}

function issueLabelNames(issue) {
  return (issue.labels?.nodes || issue.labels || []).map((l) =>
    typeof l === 'string' ? l : l.name,
  );
}

function lightPlanBusyActive(issue) {
  const labels = issueLabelNames(issue);
  return labels.includes('light-plan') && labels.includes('busy');
}

/**
 * Pure policy for when a terminal run should queue a light-plan resume instead of blocking.
 */
function lightPlanResumeEligible({ issue, prUrl, genuinelyBlocked }) {
  if (!issue || genuinelyBlocked) {
    return false;
  }
  if (prUrl) {
    return false;
  }
  return lightPlanBusyActive(issue);
}

async function applyStuckNeedsOwner({
  owner,
  repo,
  issueNumber,
  token,
  assignToken,
  state,
  stuck,
  dryRun,
  io = {},
}) {
  const nextState = {
    ...state,
    stuck,
    owner_reason: 'stuck',
  };
  if (dryRun) {
    return { stuckLimit: true, dryRun: true, stuck, nextState };
  }
  await (io.setLabels || setLabels)(owner, repo, issueNumber, ['needs-owner'], ['busy'], token);
  await (io.assignIssue || assignIssue)(owner, repo, issueNumber, OWNER_LOGIN, assignToken || token);
  await upsertPipelineState({
    owner,
    repo,
    issueNumber,
    assignToken,
    state: nextState,
    summaryLine: `Monitor: light-plan relaunch limit (\`stuck=${stuck}\`)`,
    io,
  });
  await (io.upsertMarkerComment || upsertMarkerComment)({
    owner,
    repo,
    issueNumber,
    marker: RELAUNCH_MARKER,
    body: `${RELAUNCH_MARKER}
## Light-plan monitor

\`stuck\` reached **${stuck}** — assigned @${OWNER_LOGIN} with \`needs-owner\` (**stuck**).`,
    token: assignToken || token,
  });
  return { stuckLimit: true, stuck, ownerReason: 'stuck', nextState };
}

/**
 * Relaunch a light-plan session after a terminal run while \`busy\` remains.
 */
async function applyLightPlanRelaunch({
  owner,
  repo,
  issueNumber,
  token,
  assignToken,
  dryRun,
  io = {},
}) {
  const fetch = io.fetchIssue || fetchIssue;
  const issue = await fetch(owner, repo, issueNumber, token);
  if (!lightPlanBusyActive(issue)) {
    return { skipped: true, reason: 'not-light-plan-busy' };
  }

  const { state } = await loadIssueState(owner, repo, issueNumber, token, io);
  const nextStuck = (state.stuck || 0) + 1;
  const limit = stuckLimit(process.env);

  if (nextStuck >= limit) {
    return applyStuckNeedsOwner({
      owner,
      repo,
      issueNumber,
      token,
      assignToken,
      state,
      stuck: nextStuck,
      dryRun,
      io,
    });
  }

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const promptText = buildLightPlanContinuePrompt(issue, repoUrl);

  if (dryRun) {
    return {
      dryRun: true,
      relaunch: true,
      stuck: nextStuck,
      promptChars: promptText.length,
    };
  }

  const launch = io.launchAgent || launchAgent;
  let launched;
  try {
    const model = process.env.CURSOR_AGENT_MODEL || 'composer-2.5';
    launched = await launch({
      apiKey: process.env.cursor_api_key || process.env.CURSOR_API_KEY,
      repoUrl,
      promptText,
      model,
      envVars: botLaunchEnvVars(process.env),
    });
  } catch (error) {
    return {
      relaunch: false,
      reason: 'launch-failed',
      detail: String(error.message || error).slice(0, 300),
    };
  }

  const agentId = launched?.agent?.id;
  const runId = launched?.run?.id;
  if (!agentId || !runId) {
    return { relaunch: false, reason: 'launch-failed', detail: 'missing agent/run id' };
  }

  const marker = {
    agentId,
    runId,
    issueNumber,
    status: 'running',
    dispatchedAt: new Date().toISOString(),
    agentUrl: launched.agent?.url,
    delivery: 'light-plan',
    relaunchStuck: nextStuck,
  };

  await (io.upsertMarkerComment || upsertMarkerComment)({
    owner,
    repo,
    issueNumber,
    marker: RUN_MARKER_PREFIX,
    body: buildDispatchComment(marker),
    token: assignToken || token,
  });

  const nextState = {
    ...state,
    stuck: nextStuck,
    run_id: runId,
    owner_reason: null,
  };
  await upsertPipelineState({
    owner,
    repo,
    issueNumber,
    assignToken,
    state: nextState,
    summaryLine: `Monitor: relaunch light-plan (\`stuck=${nextStuck}\`)`,
    io,
  });

  await (io.assignIssue || assignIssue)(owner, repo, issueNumber, 'pawpet-bot', assignToken || token);
  await (io.setLabels || setLabels)(owner, repo, issueNumber, ['busy'], [], token);

  await (io.upsertMarkerComment || upsertMarkerComment)({
    owner,
    repo,
    issueNumber,
    marker: RELAUNCH_MARKER,
    body: `${RELAUNCH_MARKER}
## Light-plan monitor relaunch

Continue prompt dispatched (\`continue light-plan #${issueNumber}\`). \`stuck\` is **${nextStuck}**.`,
    token: assignToken || token,
  });

  return { relaunched: true, runId, stuck: nextStuck };
}

module.exports = {
  DEFAULT_STUCK_LIMIT,
  stuckLimit,
  lightPlanBusyActive,
  lightPlanResumeEligible,
  applyLightPlanRelaunch,
  applyStuckNeedsOwner,
};