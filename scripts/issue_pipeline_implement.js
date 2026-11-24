'use strict';

const path = require('path');
const {
  fetchIssue,
  fetchAllIssueComments,
  assignIssue,
  setLabels,
  updateProjectStatus,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const {
  buildAgentPayload,
  buildAgentPrompt,
  buildDispatchComment,
} = require('../.github/scripts/agent-payload-lib');
const { launchAgent, botLaunchEnvVars } = require('../.github/scripts/launch-cursor-agent');
const { deliveryLabel } = require('./issue_pipeline_state');
const {
  findTrustedRunMarker,
  isActiveRunMarker,
  isStubRunMarker,
} = require('./lib/pipeline_run_marker');
const {
  parseAgentPathsBlock,
  evaluateDeliveryPaths,
  listTrackedFiles,
} = require('./issue_pipeline_delivery');
const OWNER_LOGIN = 'KanopeeKa';
const IMPLEMENT_MARKER = '<!-- pipeline-implement -->';
const RUN_MARKER_PREFIX = '<!-- cursor-agent-run:';

function deliveryHandoffLines(method, issueNumber) {
  switch (method) {
    case 'light-plan':
      return [
        '## Delivery mode',
        'This issue uses **light-plan**. Follow `.cursor/skills/light-plan/SKILL.md` on the tracking issue.',
        'Every phase and sync PR is driven by `/babysit-plus` (never a bare merge); the release PR is driven by `/babysit-uat`.',
        `Use \`continue light-plan #${issueNumber}\` when resuming.`,
        '',
      ];
    case 'execute-plan':
      return [
        '## Delivery mode',
        'This issue uses **execute-plan**. Initialise from the plan snapshot; do not post `approve-autonomous` (D-001).',
        'Every phase PR is driven by `/babysit-plus`; the final PR to `main` is driven by `/babysit-uat`.',
        '',
      ];
    default:
      return [
        '## Delivery mode',
        'Single PR delivery. Open PR with `Refs #' + issueNumber + '`; drive merge readiness with `/babysit-plus`.',
        '',
      ];
  }
}

/**
 * Pure guards for dispatcher row 5 (implement launch).
 */
function implementLaunchReadiness(env = process.env) {
  const launchLive = env.PIPELINE_IMPLEMENT_LAUNCH === 'true';
  const apiKey = env.cursor_api_key || env.CURSOR_API_KEY;
  return {
    launchLive,
    hasApiKey: Boolean(apiKey),
    canLaunch: launchLive && Boolean(apiKey),
  };
}

function canQueueImplement(ctx) {
  const labels = ctx.labels || [];
  const assignees = ctx.assignees || [];
  const state = ctx.state || {};
  if (ctx.status !== 'Ready') {
    return { ok: false, reason: 'not-ready' };
  }
  if (assignees.length > 0) {
    return { ok: false, reason: 'assigned' };
  }
  if (!deliveryLabel(labels)) {
    return { ok: false, reason: 'no-delivery-label' };
  }
  if (!state.converged_at) {
    return { ok: false, reason: 'not-converged' };
  }
  if (state.body_sha && ctx.liveBodySha && state.body_sha !== ctx.liveBodySha) {
    return { ok: false, reason: 'body_sha-mismatch' };
  }
  return { ok: true, method: deliveryLabel(labels) };
}

function buildPipelineImplementPrompt(issue, repoUrl, method) {
  const labels = (issue.labels?.nodes || issue.labels || []).map((l) =>
    typeof l === 'string' ? l : l.name,
  );
  const payload = buildAgentPayload(
    {
      number: issue.number,
      url: issue.url,
      title: issue.title,
      body: issue.body || '',
      labels,
    },
    repoUrl,
  );
  const extra = deliveryHandoffLines(method, issue.number).join('\n');
  return `${extra}${buildAgentPrompt(payload)}`;
}

function buildLightPlanContinuePrompt(issue, repoUrl) {
  const labels = (issue.labels?.nodes || issue.labels || []).map((l) =>
    typeof l === 'string' ? l : l.name,
  );
  const payload = buildAgentPayload(
    {
      number: issue.number,
      url: issue.url,
      title: issue.title,
      body: issue.body || '',
      labels,
    },
    repoUrl,
  );
  const lines = [
    `continue light-plan #${issue.number}`,
    '',
    ...deliveryHandoffLines('light-plan', issue.number),
    buildAgentPrompt(payload),
  ];
  return lines.join('\n');
}

async function applyImplementNeedsOwner({
  owner,
  repo,
  issueNumber,
  token,
  assignToken,
  owner_reason,
  detail,
}) {
  await setLabels(owner, repo, issueNumber, ['needs-owner'], [], token);
  await assignIssue(owner, repo, issueNumber, OWNER_LOGIN, assignToken || token);
  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: IMPLEMENT_MARKER,
    body: `${IMPLEMENT_MARKER}
## Implement launch blocked

Reason: **${owner_reason}**.

${detail || ''}`,
    token,
  });
  return { kind: 'needs-owner', owner_reason, assignee: OWNER_LOGIN };
}

/**
 * P7 implement launch: path re-check, assign in progress, optional Cursor API.
 */
async function applyImplementLaunch({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  dryRun,
  repoRoot = path.join(__dirname, '..'),
  io = {},
}) {
  const issue = await (io.fetchIssue || fetchIssue)(owner, repo, issueNumber, token);
  const labels = (issue.labels?.nodes || issue.labels || []).map((l) =>
    typeof l === 'string' ? l : l.name,
  );
  const method = deliveryLabel(labels);
  if (!method) {
    return { dryRun, action: 'implement-launch', error: 'no-delivery-label' };
  }

  const parsed = parseAgentPathsBlock(issue.body || '');
  const pathCheck = parsed.ok
    ? evaluateDeliveryPaths(parsed.globs, (io.listTrackedFiles || listTrackedFiles)(repoRoot))
    : { ok: false, reason: parsed.reason };

  if (!pathCheck.ok) {
    if (dryRun) {
      return { dryRun: true, action: 'implement-launch', pathCheck, blocked: true };
    }
    return applyImplementNeedsOwner({
      owner,
      repo,
      issueNumber,
      token,
      assignToken,
      owner_reason: pathCheck.reason || 'sensitive-paths',
      detail: `Path gate failed before launch (${pathCheck.reason}).`,
    });
  }

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const promptText = buildPipelineImplementPrompt(issue, repoUrl, method);
  const { canLaunch, launchLive, hasApiKey } = implementLaunchReadiness(process.env);

  if (dryRun) {
    return {
      dryRun: true,
      action: 'implement-launch',
      method,
      pathCheck,
      launchLive,
      hasApiKey,
      promptChars: promptText.length,
    };
  }

  if (!canLaunch) {
    return {
      action: 'implement-launch',
      method,
      skipped: true,
      reason: !launchLive ? 'launch-disabled' : 'missing-cursor-api-key',
      status: 'Ready',
    };
  }

  const botTok = assignToken || token;
  const fetchComments = io.fetchAllIssueComments || fetchAllIssueComments;
  const launch = io.launchAgent || launchAgent;

  // A previous tick may have launched but failed before the handoff writes finished.
  // Finish that handoff instead of starting a second agent.
  const existing = findTrustedRunMarker(await fetchComments(owner, repo, issueNumber, token));
  if (existing && isActiveRunMarker(existing.marker) && !isStubRunMarker(existing.marker)) {
    await completeImplementHandoff({
      owner,
      repo,
      issueNumber,
      token,
      botTok,
      projectsPat,
      projectId,
      statusFieldId,
      io,
    });
    return {
      action: 'implement-launch',
      method,
      resumed: existing.marker.runId,
      status: 'In progress',
    };
  }

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
    // #2363 §4.3: a failed launch leaves the issue queued (Ready, unassigned, label kept).
    console.log(
      JSON.stringify({
        event: 'pipeline_implement_launch_failed',
        issue: issueNumber,
        detail: String(error.message || error).slice(0, 300),
      }),
    );
    return { action: 'implement-launch', method, skipped: true, reason: 'launch-failed', status: 'Ready' };
  }

  const agentId = launched?.agent?.id;
  const runId = launched?.run?.id;
  if (!agentId || !runId) {
    console.log(
      JSON.stringify({ event: 'pipeline_implement_launch_failed', issue: issueNumber, detail: 'missing agent/run id' }),
    );
    return { action: 'implement-launch', method, skipped: true, reason: 'launch-failed', status: 'Ready' };
  }

  const marker = {
    agentId,
    runId,
    issueNumber,
    status: 'running',
    dispatchedAt: new Date().toISOString(),
    agentUrl: launched.agent?.url,
    delivery: method,
  };
  // Record the run first so a failure in the writes below is resumed, never relaunched.
  await (io.upsertMarkerComment || upsertMarkerComment)({
    owner,
    repo,
    issueNumber,
    marker: RUN_MARKER_PREFIX,
    body: buildDispatchComment(marker),
    token: botTok,
  });
  await completeImplementHandoff({
    owner,
    repo,
    issueNumber,
    token,
    botTok,
    projectsPat,
    projectId,
    statusFieldId,
    io,
  });
  return { action: 'implement-launch', method, launched: marker, status: 'In progress' };
}

async function completeImplementHandoff({
  owner,
  repo,
  issueNumber,
  token,
  botTok,
  projectsPat,
  projectId,
  statusFieldId,
  io = {},
}) {
  await (io.assignIssue || assignIssue)(owner, repo, issueNumber, 'pawpet-bot', botTok);
  await (io.setLabels || setLabels)(owner, repo, issueNumber, ['busy'], [], token);
  if (projectsPat && projectId && statusFieldId) {
    const refreshed = await (io.fetchIssue || fetchIssue)(owner, repo, issueNumber, token);
    await (io.updateProjectStatus || updateProjectStatus)({
      issue: refreshed,
      projectId,
      statusFieldId,
      statusName: 'In progress',
      projectsPat,
    });
  }
}

module.exports = {
  IMPLEMENT_MARKER,
  implementLaunchReadiness,
  canQueueImplement,
  buildPipelineImplementPrompt,
  buildLightPlanContinuePrompt,
  deliveryHandoffLines,
  applyImplementLaunch,
  applyImplementNeedsOwner,
};