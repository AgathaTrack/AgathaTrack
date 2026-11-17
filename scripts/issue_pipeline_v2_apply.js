'use strict';

/**
 * Pipeline v2 action executor (#2385 run B). `applyAction` turns one decision into REST calls.
 * Every call goes through one `request` function: in a dry run it only records the call, so the
 * planned requests are the same ones a live run would make. The caller decides live or dry from
 * the mode and the engine identity check; nothing here reads the environment.
 */

const { rest } = require('../.github/scripts/github-project-lib');
const { agentLogins } = require('./issue_pipeline_v2_config');
const { buildFieldWrites } = require('./issue_pipeline_v2_fields');
const { buildSpecRequest, buildWake } = require('./issue_pipeline_v2_comments');
const { buildReviewRequest } = require('./issue_pipeline_v2_review');
const { buildIntentReviewRequest } = require('./issue_pipeline_v2_intent');
const { buildResume } = require('./issue_pipeline_v2_release');
const { buildLaunchAcked, buildLaunchFailed, buildLaunchRecord } = require('./issue_pipeline_v2_launch');

/**
 * Field writes for one decision: the stage or blocked change, the attempt count on a reassign,
 * and the display-only `Total N` counter. The counter is written even when the decision is
 * `none`, so a stable issue's counter does not go stale.
 */
function buildWrites({ action, parsed, counters }) {
  const writes = {};
  if (action.type === 'set-stage') {
    writes.stage = action.to;
    writes.attempts = 0;
  } else if (action.type === 'set-blocked') {
    writes.blocked = action.reason;
  } else if (
    (action.type === 'reassign' || action.type === 'launch') &&
    Number.isFinite(action.attempts) &&
    action.attempts !== parsed.attempts
  ) {
    writes.attempts = action.attempts;
  }
  return { ...writes, ...counters };
}

/**
 * The doorbell: ring one agent by assigning it. Humans on the issue stay assigned, other agents
 * do not, so exactly one agent holds the turn. The assignee is a notification; no decision reads it.
 */
function doorbellAssignees(current, agent, config) {
  const agents = new Set(agentLogins(config));
  const humans = (current || []).filter((login) => !agents.has(login));
  return [...humans, agent];
}

function issuePath({ owner, repo, issueNumber }) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;
}

/**
 * @param {object} args
 * @param {object} args.action        a `decide()` result
 * @param {object} args.ctx           { owner, repo, issueNumber, token, config, fields, parsed,
 *                                      assignees, counters, facts, dryRun, restFn }
 * @returns {Promise<{ applied: string[], calls: Array<{method: string, path: string, body?: object}> }>}
 */
async function applyAction({ action: decided, ctx }) {
  let action = decided;
  const calls = [];
  const live = ctx.restFn || rest;
  const request = async (method, path, body) => {
    calls.push({ method, path, ...(body ? { body } : {}) });
    return ctx.dryRun ? { id: 0 } : live(method, path, ctx.token, body);
  };
  const base = issuePath(ctx);
  const applied = [];

  const assign = async (agent) => {
    await request('PATCH', base, { assignees: doorbellAssignees(ctx.assignees, agent, ctx.config) });
    applied.push(`assign:${agent}`);
  };
  const comment = async (body, label) => {
    await request('POST', `${base}/comments`, { body });
    applied.push(label);
  };
  const editComment = async (id, body, label) => {
    await request('PATCH', `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/issues/comments/${id}`, { body });
    applied.push(label);
  };

  switch (action.type) {
    case 'request-spec':
      await comment(buildSpecRequest({ assigned: action.agent }), 'comment:spec-request');
      await assign(action.agent);
      break;
    case 'request-review':
      await comment(
        buildReviewRequest({ hash: action.hash, assigned: action.agent }),
        'comment:review-request',
      );
      await assign(action.agent);
      break;
    case 'reassign': {
      const inReview = action.stage === 'In analysis';
      const held = inReview ? ctx.facts.review : ctx.facts.spec;
      const history = [...new Set([...(held?.timedOut || []), ...(held?.assignedTo ? [held.assignedTo] : [])])];
      const body = inReview
        ? buildReviewRequest({ hash: ctx.facts.review.requestedHash, assigned: action.agent, history })
        : buildSpecRequest({ assigned: action.agent, history });
      await editComment(held.commentId, body, `edit:${inReview ? 'review' : 'spec'}-request`);
      await assign(action.agent);
      break;
    }
    case 'wake-stage-agent':
      await comment(buildWake({ commentId: action.commentId, agent: action.agent }), 'comment:wake');
      await assign(action.agent);
      break;
    case 'launch': {
      let attempts = action.attempts;
      try {
        const run = ctx.dryRun
          ? { runId: 'dry-run', agentUrl: '' }
          : await ctx.launchFn({ agent: action.agent, method: action.method });
        calls.push({ method: 'POST', path: 'cursor:/v1/agents', body: { agent: action.agent, method: action.method } });
        await comment(buildLaunchRecord({ runId: run.runId, agent: action.agent, agentUrl: run.agentUrl }), 'comment:launch');
        applied.unshift(`launch:${action.agent}`);
      } catch (error) {
        attempts = (action.attempts || 0) + 1;
        await comment(buildLaunchFailed({ agent: action.agent, reason: error.message }), 'comment:launch-failed');
        applied.unshift(`launch-failed:${action.agent}`);
      }
      // The launch is one of the failed runs until the agent reports busy, so record the count now.
      action = { ...action, attempts };
      break;
    }
    case 'request-intent-review':
      await comment(
        buildIntentReviewRequest({
          agent: action.agent,
          issueNumber: ctx.issueNumber,
          prNumbers: ctx.facts.delivery?.mergedPrNumbers,
        }),
        'comment:intent-review',
      );
      await assign(action.agent);
      break;
    case 'resume': {
      let ok = true;
      try {
        if (!ctx.dryRun) {
          await ctx.launchFn({ agent: action.agent, method: action.method });
        }
        calls.push({ method: 'POST', path: 'cursor:/v1/agents', body: { agent: action.agent, method: action.method } });
      } catch {
        ok = false;
      }
      // The resume is recorded even when it failed: the next tick then marks the issue stalled.
      await comment(buildResume({ agent: action.agent, ok }), 'comment:resume');
      applied.unshift(`${ok ? 'resume' : 'resume-failed'}:${action.agent}`);
      break;
    }
    case 'set-stage':
      if (action.to === 'Done') {
        await request('POST', `${base}/labels`, { labels: ['in-prod'] });
        await request('DELETE', `${base}/labels/busy`).catch(() => {}); // already gone is fine
        applied.push('labels:in-prod');
      }
      if (action.to === 'In progress' && ctx.facts.launch?.runId) {
        await comment(buildLaunchAcked({ runId: ctx.facts.launch.runId }), 'comment:launch-acked');
      }
      break;
    case 'set-blocked':
    case 'none':
      break;
    default:
      return { applied: [`unsupported:${action.type}`], calls };
  }

  const writes = buildWrites({ action, parsed: ctx.parsed, counters: ctx.counters || {} });
  const patch = {};
  if (Object.keys(writes).length > 0) {
    patch.issue_field_values = buildFieldWrites(ctx.fields, writes);
  }
  if (action.type === 'set-stage' && action.close) {
    patch.state = 'closed';
    patch.state_reason = 'completed';
  }
  if (Object.keys(patch).length > 0) {
    await request('PATCH', base, patch);
    applied.push(`fields:${Object.keys(writes).join(',') || 'state'}`);
  }
  return { applied, calls };
}

module.exports = { buildWrites, doorbellAssignees, applyAction };
