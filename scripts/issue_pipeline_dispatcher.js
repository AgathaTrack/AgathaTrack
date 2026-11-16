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
  fetchPipelineIssueForProject,
} = require('./issue_pipeline_project');
const { isDispatcherEligibleIssue } = require('./issue_pipeline_gate');
const { resolvePipelineMode } = require('./issue_pipeline_mode');
const { runTodoLanePipeline } = require('./issue_pipeline_intake');
const { loadIssueState, fetchLatestBodyEdit } = require('./issue_pipeline_state_load');
const { untrustedStateSkipReason, isOwnerBodyEdit } = require('./issue_pipeline_guards');
const {
  applyReopenAnalysis,
  applyReviewStub,
  applyNeedsOwnerConvergence,
} = require('./issue_pipeline_review');
const { applyDeliveryStub } = require('./issue_pipeline_delivery');
const { canQueueImplement, applyImplementLaunch } = require('./issue_pipeline_implement');
const { applyMonitorTick } = require('./issue_pipeline_monitor');
const {
  countByColumn,
  buildHealthPayload,
  buildScheduleHealth,
  emitHealthReport,
} = require('./issue_pipeline_health');

const BOTS = new Set(['pawpet-claude', 'pawpet-bot']);
const OWNER_LOGIN = 'KanopeeKa';

const LANE_CAPS = {
  intake: 2,
  review: 2,
  delivery: 1,
  monitor: 2,
};

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
  const status = ctx.status;

  if (status === 'In Analysis' && hasDeliveryLabel(ctx.labels)) {
    return true;
  }
  if (status === 'Ready' && hasDeliveryLabel(ctx.labels) && !state.converged_at) {
    return true;
  }
  if (
    status === 'Ready' &&
    state.converged_at &&
    stateSha &&
    liveSha !== stateSha
  ) {
    return true;
  }
  return false;
}

const PIPELINE_ASSIGNEES = new Set(['pawpet-claude', 'pawpet-bot', OWNER_LOGIN]);

function countPipelineAssignees(assignees) {
  return (assignees || []).filter((login) => PIPELINE_ASSIGNEES.has(login)).length;
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

  const resolveIssueState =
    (io && io.loadIssueState) ||
    ((o, r, n, t) => loadIssueState(o, r, n, t));

  let issues;
  let boardIssues = null;
  if (issueNumber) {
    const fetchOne =
      (io && io.fetchPipelineIssueForProject) ||
      ((o, r, t, c, n) => fetchPipelineIssueForProject(o, r, t, c, n));
    try {
      const row = await fetchOne(owner, repo, token, config, issueNumber);
      if (!row) {
        console.log(
          JSON.stringify({
            event: 'pipeline_issue_not_on_project',
            issue: Number(issueNumber),
            reason: 'no open item for GH_PROJECT_ID',
          }),
        );
      }
      issues = row ? [row] : [];
    } catch (error) {
      const message = String(error.message || error);
      if (/not found|Could not resolve to an Issue/i.test(message)) {
        console.log(
          JSON.stringify({
            event: 'pipeline_tick_skipped',
            issue: Number(issueNumber),
            reason: 'not_an_issue',
            detail: message.slice(0, 200),
          }),
        );
        return {
          mode: pipelineMode,
          skipped: true,
          reason: 'not_an_issue',
          actions: [],
        };
      }
      throw error;
    }
    // #2363 §2.4: a scoped (debug) tick still counts WIP over the whole board.
    boardIssues = issues.length > 0 ? await listIssues(owner, repo, token, config) : issues;
  } else {
    issues = await listIssues(owner, repo, token, config);
    boardIssues = issues;
  }

  const wipMax = Number(process.env.WIP_MAX || 2);
  const wipInUse = countWipInUse(boardIssues);

  const planned = [];
  for (const issue of issues) {
    if (!isDispatcherEligibleIssue(issue, pipelineMode)) {
      continue;
    }
    if (countPipelineAssignees(issue.assignees) > 1) {
      console.log(
        JSON.stringify({
          event: 'pipeline_skip',
          issue: issue.number,
          reason: 'multiple-pipeline-assignees',
          assignees: issue.assignees,
        }),
      );
      continue;
    }
    const liveBodySha = bodySha(issue.body);
    const { state, source } = await resolveIssueState(owner, repo, issue.number, token);
    const stateSkip = untrustedStateSkipReason(issue.status, source);
    if (stateSkip) {
      console.log(
        JSON.stringify({ event: 'pipeline_skip', issue: issue.number, reason: stateSkip }),
      );
      continue;
    }
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

  const assignToken = (io && 'assignToken' in io) ? io.assignToken : process.env.EXECUTE_PLAN_BOT_TOKEN;
  const errors = [];
  let liveMode = pipelineMode;
  if (pipelineMode === 'on' && !assignToken) {
    // State and handoffs need the bot identity; without it nothing written would be trusted.
    errors.push({ issue: null, action: 'tick', message: 'EXECUTE_PLAN_BOT_TOKEN missing; no writes' });
    console.log(JSON.stringify({ event: 'pipeline_tick_error', reason: 'missing-bot-token' }));
    liveMode = 'dry-run';
  }
  const dryRun = liveMode !== 'on';
  const runTodoLane =
    (io && io.runTodoLanePipeline) || ((args) => runTodoLanePipeline(args));
  const executed = [];
  for (const row of actions) {
    const payload = {
      event: 'pipeline_action',
      mode: pipelineMode,
      dry_run: dryRun,
      workers_enabled: pipelineMode === 'on',
      ...row,
    };
    if (liveMode === 'on') {
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
      try {
        if (row.action === 'triage-intake') {
          run = await runTodoLane(baseRun);
        } else if (row.action === 'reopen-analysis') {
          const issueRow = issues.find((i) => i.number === row.issue);
          const { state, updatedAt } = await loadIssueState(owner, repo, row.issue, token);
          const readBodyEdit =
            (io && io.fetchLatestBodyEdit) ||
            ((o, r, n) => fetchLatestBodyEdit(token, o, r, n));
          const ownerEdited = isOwnerBodyEdit(await readBodyEdit(owner, repo, row.issue), updatedAt);
          run = await applyReopenAnalysis({
            ...baseRun,
            state,
            ownerEdited,
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
            labels: issueRow?.labels || [],
            body: issueRow?.body || '',
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
      } catch (laneError) {
        const message = String(laneError.message || laneError).slice(0, 300);
        errors.push({ issue: row.issue, action: row.action, message });
        payload.error = message;
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
    errors,
    wipInUse,
    wipMax,
    issueCount: issues.length,
    byColumn: countByColumn(issues),
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

  const eventName = process.env.EVENT_NAME || null;
  const result = await tick({ owner, repo, token, issueNumber });
  if (result.skipped) {
    console.log(JSON.stringify({ event: 'pipeline_tick_skipped', ...result }));
    return;
  }
  console.log(JSON.stringify({ event: 'pipeline_tick_complete', ...result }));

  const scheduleFullBoard =
    eventName === 'schedule' && (issueNumber == null || Number.isNaN(issueNumber));
  if (scheduleFullBoard) {
    const nowMs = Date.now();
    const schedule = await buildScheduleHealth(owner, repo, token, nowMs);
    const health = buildHealthPayload({
      mode: result.mode,
      dryRun: result.dryRun,
      eventName,
      at: new Date(nowMs).toISOString(),
      byColumn: result.byColumn,
      issueCount: result.issueCount,
      wipInUse: result.wipInUse,
      wipMax: result.wipMax,
      actions: result.actions,
      executed: result.executed,
      errors: result.errors,
      schedule,
    });
    emitHealthReport(health);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  resolvePipelineMode, // re-export from ./issue_pipeline_mode
  computeEligibleAction,
  countWipInUse,
  untrustedStateSkipReason,
  isOwnerBodyEdit,
  applyLaneCaps,
  tick,
  OWNER_LOGIN,
};