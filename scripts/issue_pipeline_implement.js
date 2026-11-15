'use strict';

const path = require('path');
const {
  fetchIssue,
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
        `Use \`continue light-plan #${issueNumber}\` when resuming.`,
        '',
      ];
    case 'execute-plan':
      return [
        '## Delivery mode',
        'This issue uses **execute-plan**. Initialise from the plan snapshot; do not post `approve-autonomous` (D-001).',
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
}) {
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const labels = (issue.labels?.nodes || issue.labels || []).map((l) =>
    typeof l === 'string' ? l : l.name,
  );
  const method = deliveryLabel(labels);
  if (!method) {
    return { dryRun, action: 'implement-launch', error: 'no-delivery-label' };
  }

  const parsed = parseAgentPathsBlock(issue.body || '');
  const pathCheck = parsed.ok
    ? evaluateDeliveryPaths(parsed.globs, listTrackedFiles(repoRoot))
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
      owner_reason: 'sensitive-paths',
      detail: `Path gate failed before launch (${pathCheck.reason}).`,
    });
  }

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const promptText = buildPipelineImplementPrompt(issue, repoUrl, method);
  const launchLive = process.env.PIPELINE_IMPLEMENT_LAUNCH === 'true';
  const apiKey = process.env.cursor_api_key || process.env.CURSOR_API_KEY;

  if (dryRun) {
    return {
      dryRun: true,
      action: 'implement-launch',
      method,
      pathCheck,
      launchLive,
      promptChars: promptText.length,
    };
  }

  const botTok = assignToken || token;
  await assignIssue(owner, repo, issueNumber, 'pawpet-bot', botTok);
  await setLabels(owner, repo, issueNumber, ['busy'], [], token);

  if (projectsPat && projectId && statusFieldId) {
    const refreshed = await fetchIssue(owner, repo, issueNumber, token);
    await updateProjectStatus({
      issue: refreshed,
      projectId,
      statusFieldId,
      statusName: 'In progress',
      projectsPat,
    });
  }

  if (!launchLive || !apiKey) {
    const stubMarker = {
      agentId: 'pipeline-stub',
      runId: 'pipeline-stub',
      issueNumber,
      status: 'running',
      dispatchedAt: new Date().toISOString(),
      stub: true,
      delivery: method,
    };
    await upsertMarkerComment({
      owner,
      repo,
      issueNumber,
      marker: RUN_MARKER_PREFIX,
      body: buildDispatchComment(stubMarker),
      token,
    });
    return { action: 'implement-launch', method, stub: true, status: 'In progress' };
  }

  try {
    const model = process.env.CURSOR_AGENT_MODEL || 'composer-2.5';
    const launched = await launchAgent({
      apiKey,
      repoUrl,
      promptText,
      model,
      envVars: botLaunchEnvVars(process.env),
    });
    const agentId = launched.agent?.id;
    const runId = launched.run?.id;
    if (!agentId || !runId) {
      await setLabels(owner, repo, issueNumber, [], ['busy'], token);
      return applyImplementNeedsOwner({
        owner,
        repo,
        issueNumber,
        token,
        assignToken,
        owner_reason: 'launch-failed',
        detail: 'Cursor API response missing agent/run id.',
      });
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
    await upsertMarkerComment({
      owner,
      repo,
      issueNumber,
      marker: RUN_MARKER_PREFIX,
      body: buildDispatchComment(marker),
      token,
    });
    return { action: 'implement-launch', method, launched: marker, status: 'In progress' };
  } catch (error) {
    await setLabels(owner, repo, issueNumber, [], ['busy'], token);
    return applyImplementNeedsOwner({
      owner,
      repo,
      issueNumber,
      token,
      assignToken,
      owner_reason: 'launch-failed',
      detail: error.message,
    });
  }
}

module.exports = {
  IMPLEMENT_MARKER,
  canQueueImplement,
  buildPipelineImplementPrompt,
  deliveryHandoffLines,
  applyImplementLaunch,
};