#!/usr/bin/env node
'use strict';

const { parseRepo } = require('../.github/scripts/github-project-lib');
const {
  bodySha,
  defaultState,
  DEFAULT_ROUND_CAP,
  hasDeliveryLabel,
} = require('./issue_pipeline_state');
const {
  loadProjectSecrets,
  assertPipelineStatusOptions,
  listPipelineIssues,
} = require('./issue_pipeline_project');
const { isPipelineIssue } = require('./issue_pipeline_gate');
const { runTodoLanePipeline } = require('./issue_pipeline_intake');
const { loadIssueState } = require('./issue_pipeline_state_load');
const {
  applyReopenAnalysis,
  applyReviewStub,
  applyNeedsOwnerConvergence,
} = require('./issue_pipeline_review');
const { applyDeliveryStub } = require('./issue_pipeline_delivery');
const { canQueueImplement, applyImplementLaunch } = require('./issue_pipeline_implement');
const { applyMonitorTick } = require('./issue_pipeline_monitor');

const BOTS = new Set(['pawpet-claude', 'pawpet-bot']);
const OWNER_LOGIN = 'KanopeeKa';

const LANE_CAPS = {
  intake: 2,
  review: 2,
  delivery: 1,
  monitor: 2,
};

function resolvePipelineMode(raw = process.env.ISSUE_PIPELINE) {
  const mode = String(raw || 'off').trim().toLowerCase();
  if (mode === 'on' || mode === 'dry-run') {
    return mode;
  }
  return 'off';
}

function hasLabel(labels, name) {
  return (labels || []).includes(name);
}

function primaryAssignee(assignees) {
  if (!assignees?.length) {
    return null;
  }
  return assignees[0];
}

function needsReopenAnalysis(ctx) {
  const state = ctx.state || defaultState();
  const liveSha = ctx.liveBodySha;
  const stateSha = state.body_sha || null;
  if (stateSha && liveSha !== stateSha) {
    return true;
  }
  if (ctx.status === 'In Analysis' && hasDeliveryLabel(ctx.labels)) {
    return true;
  }
  if (ctx.status === 'Ready' && hasDeliveryLabel(ctx.labels) && !state.converged_at) {
    return true;
  }
  return false;
}

/**
 * At most one action per issue (dispatcher-spec §3.1). Returns null when no work.
 */
function computeEligibleAction(ctx, options = {}) {
  const roundCap = options.roundCap ?? DEFAULT_ROUND_CAP;
  const labels = ctx.labels || [];
  const assignee = primaryAssignee(ctx.assignees);
  const status = ctx.status;
  const state = ctx.state || defaultState();

  if (hasLabel(labels, 'manual-only')) {
    return null;
  }

  if (hasLabel(labels, 'needs-owner') && assignee === OWNER_LOGIN) {
    return null;
  }

  if (needsReopenAnalysis(ctx)) {
    return {
      priority: 3.1,
      action: 'reopen-analysis',
      lane: 'review',
      reason: 'body_sha or delivery mismatch',
    };
  }

  if (status === 'To do' && assignee === 'pawpet-claude' && !hasLabel(labels, 'question')) {
    return { priority: 2, action: 'triage-intake', lane: 'triage', reason: 'todo-claude' };
  }

  if (status === 'In Analysis' && assignee && BOTS.has(assignee)) {
    if ((state.round || 0) >= roundCap) {
      return {
        priority: 3.5,
        action: 'needs-owner-convergence',
        lane: 'review',
        reason: 'round-cap',
      };
    }
    return { priority: 3, action: 'review', lane: 'review', reason: 'in-analysis' };
  }

  if (
    status === 'Ready' &&
    assignee === 'pawpet-bot' &&
    !hasDeliveryLabel(labels) &&
    state.converged_at &&
    state.body_sha === ctx.liveBodySha
  ) {
    return { priority: 4, action: 'delivery', lane: 'delivery', reason: 'ready-delivery' };
  }

  if (status === 'Ready' && hasDeliveryLabel(labels) && !assignee) {
    const implement = canQueueImplement({
      status,
      labels,
      assignees: ctx.assignees || [],
      state,
      liveBodySha: ctx.liveBodySha,
    });
    if (!implement.ok) {
      return null;
    }
    return {
      priority: 5,
      action: 'implement-launch',
      lane: 'implement',
      reason: 'ready-queued',
      delivery: implement.method,
    };
  }

  if (status === 'In progress' && assignee === 'pawpet-bot') {
    return { priority: 6, action: 'monitor', lane: 'monitor', reason: 'in-progress' };
  }

  return null;
}

function countWipInUse(issues) {
  return issues.filter((issue) => {
    if (issue.status !== 'In progress') {
      return false;
    }
    return primaryAssignee(issue.assignees) === 'pawpet-bot';
  }).length;
}

function laneCapFor(item, wipMax, wipInUse) {
  if (item.lane === 'implement') {
    return Math.max(0, wipMax - wipInUse);
  }
  return LANE_CAPS[item.lane] ?? 1;
}

function applyLaneCaps(planned, wipMax, wipInUse) {
  const laneUse = {};
  const accepted = [];
  for (const item of planned) {
    const cap = laneCapFor(item, wipMax, wipInUse);
    const used = laneUse[item.lane] || 0;
    if (used >= cap) {
      continue;
    }
    laneUse[item.lane] = used + 1;
    accepted.push(item);
    if (item.lane === 'implement') {
      wipInUse += 1;
    }
  }
  return accepted;
}

async function tick({ owner, repo, token, issueNumber, mode, io } = {}) {
  const pipelineMode = mode ?? resolvePipelineMode();
  if (pipelineMode === 'off') {
    return { mode: pipelineMode, skipped: true, reason: 'ISSUE_PIPELINE off', actions: [] };
  }

  const config = (io && io.projectSecrets) || loadProjectSecrets();
  if (!config) {
    return {
      mode: pipelineMode,
      skipped: true,
      reason: 'project_secrets_missing',
      actions: [],
    };
  }

  const listIssues =
    (io && io.listPipelineIssues) ||
    ((o, r, t, c) => listPipelineIssues(o, r, t, c));
  const assertOptions =
    (io && io.assertPipelineStatusOptions) ||
    ((pat, fieldId) => assertPipelineStatusOptions(pat, fieldId));

  await assertOptions(config.projectsPat, config.statusFieldId);

  let issues = await listIssues(owner, repo, token, config);
  if (issueNumber) {
    issues = issues.filter((issue) => issue.number === Number(issueNumber));
  }

  const wipMax = Number(process.env.WIP_MAX || 2);
  const wipInUse = countWipInUse(issues);

  const planned = [];
  for (const issue of issues) {
    if (!isPipelineIssue(issue.labels, pipelineMode)) {
      continue;
    }
    const liveBodySha = bodySha(issue.body);
    const { state } = await loadIssueState(owner, repo, issue.number, token);
    const action = computeEligibleAction({
      ...issue,
      liveBodySha,
      state,
    });
    if (!action) {
      continue;
    }
    planned.push({
      issue: issue.number,
      status: issue.status,
      assignee: primaryAssignee(issue.assignees),
      ...action,
    });
  }

  planned.sort((a, b) => a.priority - b.priority || a.issue - b.issue);
  const actions = applyLaneCaps(planned, wipMax, wipInUse);

  const dryRun = pipelineMode !== 'on';
  const assignToken = process.env.EXECUTE_PLAN_BOT_TOKEN;
  const executed = [];
  for (const row of actions) {
    const payload = {
      event: 'pipeline_action',
      mode: pipelineMode,
      dry_run: dryRun,
      workers_enabled: pipelineMode === 'on',
      ...row,
    };
    if (pipelineMode === 'on') {
      const baseRun = {
        owner,
        repo,
        issueNumber: row.issue,
        token,
        projectsPat: config.projectsPat,
        projectId: config.projectId,
        statusFieldId: config.statusFieldId,
        assignToken,
        dryRun: false,
      };
      let run;
      if (row.action === 'triage-intake') {
        run = await runTodoLanePipeline(baseRun);
      } else if (row.action === 'reopen-analysis') {
        const issueRow = issues.find((i) => i.number === row.issue);
        const { state } = await loadIssueState(owner, repo, row.issue, token);
        run = await applyReopenAnalysis({
          ...baseRun,
          state,
          liveBodySha: bodySha(issueRow?.body || ''),
        });
      } else if (row.action === 'needs-owner-convergence') {
        const issueRow = issues.find((i) => i.number === row.issue);
        const { state } = await loadIssueState(owner, repo, row.issue, token);
        run = await applyNeedsOwnerConvergence({
          ...baseRun,
          state,
          liveBodySha: bodySha(issueRow?.body || ''),
        });
      } else if (row.action === 'review') {
        const issueRow = issues.find((i) => i.number === row.issue);
        const { state } = await loadIssueState(owner, repo, row.issue, token);
        run = await applyReviewStub({
          ...baseRun,
          state,
          liveBodySha: bodySha(issueRow?.body || ''),
          reviewer: row.assignee,
        });
      } else if (row.action === 'delivery') {
        const issueRow = issues.find((i) => i.number === row.issue);
        const { state } = await loadIssueState(owner, repo, row.issue, token);
        run = await applyDeliveryStub({
          ...baseRun,
          state,
          liveBodySha: bodySha(issueRow?.body || ''),
        });
      } else if (row.action === 'implement-launch') {
        run = await applyImplementLaunch(baseRun);
      } else if (row.action === 'monitor') {
        run = await applyMonitorTick(baseRun);
      }
      if (run) {
        executed.push({ issue: row.issue, run });
        payload.executed = run;
      }
    }
    console.log(JSON.stringify(payload));
  }

  return {
    mode: pipelineMode,
    dryRun,
    actions,
    executed,
    wipInUse,
    wipMax,
    issueCount: issues.length,
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN is required');
  }
  const { owner, repo } = parseRepo(repository);
  const issueNumber = process.env.ISSUE_NUMBER
    ? Number(process.env.ISSUE_NUMBER)
    : null;

  const result = await tick({ owner, repo, token, issueNumber });
  if (result.skipped) {
    console.log(JSON.stringify({ event: 'pipeline_tick_skipped', ...result }));
    return;
  }
  console.log(JSON.stringify({ event: 'pipeline_tick_complete', ...result }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  resolvePipelineMode,
  computeEligibleAction,
  countWipInUse,
  applyLaneCaps,
  tick,
  OWNER_LOGIN,
};