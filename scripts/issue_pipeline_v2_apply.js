'use strict';

/**
 * Pipeline v2 action executor (#2385 run B). `applyAction` turns one decision into REST calls.
 * Every call goes through one `request` function: in a dry run it only records the call, so the
 * planned requests are the same ones a live run would make. The caller decides live or dry from
 * the mode and the engine identity check; nothing here reads the environment.
 */

const { rest } = require('../.github/scripts/github-project-lib');
const { agentLogins, resolveAgent } = require('./issue_pipeline_v2_config');
const { buildIssueFieldPatch, parseIssueFields } = require('./issue_pipeline_v2_fields');
const { buildSpecRequest, buildWake } = require('./issue_pipeline_v2_comments');
const { buildReviewRequest } = require('./issue_pipeline_v2_review');
const { buildIntentReviewRequest } = require('./issue_pipeline_v2_intent');
const { buildReopened, buildResume } = require('./issue_pipeline_v2_release');
const { buildLaunchAcked, buildLaunchFailed, buildLaunchPending, buildLaunchRecord } = require('./issue_pipeline_v2_launch');
const {
  buildAatLaunch,
  buildAatRelaunch,
  buildAatReset,
  buildAatStateMarker,
  buildAatWaive,
} = require('./issue_pipeline_v2_acceptance');
const { randomNonceHex } = require('./issue_pipeline_v2_secrets');
const { isRunnerQueuedError } = require('./pipeline_runners/claude');
const { buildRoundMarker, roundFor } = require('./issue_pipeline_v2_round_markers');
const { authorOf } = require('./issue_pipeline_v2_rounds');
const { buildHold, buildRelease, isEngineHold } = require('./issue_pipeline_v2_holds');

/**
 * Field writes for one decision: the stage or blocked change, the attempt count on a reassign,
 * and nothing else.
 */
function buildWrites({ action, parsed }) {
  const writes = {};
  if (action.type === 'set-stage') {
    writes.stage = action.to;
    writes.attempts = 0;
  } else if (action.type === 'set-blocked') {
    writes.blocked = action.reason;
  } else if (action.type === 'release-hold') {
    // A release starts the count afresh. An engine release also clears the flag; a human already did.
    if (action.by === 'engine') writes.blocked = null;
    if (parsed?.attempts) writes.attempts = 0;
  } else if (
    (action.type === 'reassign' || action.type === 'launch') &&
    Number.isFinite(action.attempts) &&
    action.attempts !== parsed.attempts
  ) {
    writes.attempts = action.attempts;
  }
  if (Object.prototype.hasOwnProperty.call(action, 'acceptance')) writes.acceptance = action.acceptance;
  if (Object.prototype.hasOwnProperty.call(action, 'acceptanceFailReason')) {
    writes.acceptanceFailReason = action.acceptanceFailReason;
  }
  return writes;
}

/**
 * The doorbell: ring one agent by assigning it. Humans on the issue stay assigned, other agents
 * do not, so exactly one agent holds the turn. The assignee is a notification; no decision reads it.
 */
function doorbellAssignees(current, agentId, config) {
  const poolActsAs = new Set(agentLogins(config));
  const poolIds = new Set((config.agents || []).map((entry) => entry.id || entry.login).filter(Boolean));
  const humans = (current || []).filter(
    (login) => !poolActsAs.has(login) && !poolIds.has(login),
  );
  const actsAs = resolveAgent(config, agentId)?.actsAs || agentId;
  return [...humans, actsAs];
}

function issuePath({ owner, repo, issueNumber }) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;
}

/**
 * @param {object} args
 * @param {object} args.action        a `decide()` result
 * @param {object} args.ctx           { owner, repo, issueNumber, token, config, fields, parsed,
 *                                      assignees, facts, dryRun, restFn }
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
  // P3 round markers: the round context comes from the same derivation as the P4 plan. With no plan
  // (its derivation failed), a marker still records the event but leaves the round label out.
  const plan = ctx.facts?.roundPlan && !ctx.facts.roundPlan.error ? ctx.facts.roundPlan : null;
  const reviewsSoFar = plan ? plan.reviews : null;
  const authorLabel = (hash) => {
    if (!plan) return 'none';
    const author = authorOf(plan.derived, hash);
    return author.human ? 'human' : author.type;
  };
  const brandOf = (id) => resolveAgent(ctx.config, id)?.runner || null;
  // The assignee and hash of the newest review round, when its edit closed it (a new hash, not a hold).
  const lastRoundEdit = (derived) => {
    const last = (derived || []).filter((round) => round.kind === 'review').at(-1);
    const attempt = last?.attempts.at(-1);
    return attempt?.hashOut && attempt.hashOut !== last.hashIn ? { type: attempt.type, hash: attempt.hashOut } : null;
  };
  // A review number `k` gives its label; a null `k` (no plan) gives no label.
  const currentRound = (k) => (k === null || k === undefined ? null : roundFor(k));
  const roundCtx = (k, attempt, hash, author) => {
    const label = currentRound(k);
    return { round: label?.round ?? null, tier: label?.tier ?? null, attempt, hash, author };
  };
  const isGithubNotFound = (error) => /failed \(404\)/.test(String(error?.message ?? ''));
  const deleteBusyLabel = async () => {
    try {
      await request('DELETE', `${base}/labels/busy`);
    } catch (error) {
      if (!isGithubNotFound(error)) {
        throw error;
      }
    }
  };
  const deleteQueuedLabel = async () => {
    try {
      await request('DELETE', `${base}/labels/queued`);
    } catch (error) {
      if (!isGithubNotFound(error)) {
        throw error;
      }
    }
  };
  try {

    const assign = async (agent) => {
      await request('PATCH', base, { assignees: doorbellAssignees(ctx.assignees, agent, ctx.config) });
      applied.push(`assign:${agent}`);
    };
    const comment = async (body, label) => {
      await request('POST', `${base}/comments`, { body });
      applied.push(label);
    };
    const writeMarker = (fields) => comment(buildRoundMarker(fields), `comment:round-${fields.event}`);
    const editComment = async (id, body, label) => {
      await request('PATCH', `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}/issues/comments/${id}`, { body });
      applied.push(label);
    };

    // Doorbell: an agent the engine can start is also launched for the spec or review it was asked to do.
    // A failed ring never fails the tick; the pickup timeout reassigns if nobody answers.
    const ring = async (agent, stage, round = null) => {
      const entry = resolveAgent(ctx.config, agent);
      if (!entry || !(ctx.config.launchRunners || []).includes(entry.runner) || !['To do', 'In analysis', 'In Main'].includes(stage)) {
        return;
      }
      const markerBase = round ? { ...round, identity: agent, brand: entry.runner } : null;
      const nonce = randomNonceHex();
      try {
        let runId = 'dry-run';
        if (!ctx.dryRun) {
          const run = await ctx.launchFn({
            agent,
            stage,
            purpose: 'doorbell',
            nonce,
            config: ctx.config,
          });
          runId = run?.runId;
          if (!runId) {
            throw new Error('doorbell launch missing run id');
          }
        }
        if (ctx.dryRun) {
          calls.push({ method: 'POST', path: `${base}/labels`, body: { labels: ['busy'] } });
        }
        calls.push({ method: 'POST', path: 'cursor:/v1/agents', body: { agent, stage, nonce } });
        await comment(
          buildLaunchRecord({
            runId,
            agent,
            purpose: 'doorbell',
            stage,
            nonce,
          }),
          'comment:doorbell-launch',
        );
        applied.push(`doorbell:${agent}`);
        if (markerBase) {
          // The run id is audit data. The nonce is never written to a marker (PIPE-V2-D-REV3-010).
          await writeMarker({ ...markerBase, event: 'start', runId });
        }
        await deleteQueuedLabel();
        applied.push('labels:queued-removed');
      } catch (error) {
        if (isRunnerQueuedError(error)) {
          await request('POST', `${base}/labels`, { labels: ['queued'] });
          applied.push(`runner-queued:${agent}`);
          if (markerBase) {
            await writeMarker({ ...markerBase, event: 'queued' });
          }
          return;
        }
        await deleteQueuedLabel();
        applied.push('labels:queued-removed');
        applied.push(`doorbell-failed:${agent}:${String(error?.message ?? error).slice(0, 120)}`);
        if (markerBase) {
          await writeMarker({ ...markerBase, event: 'fail', failure: 'ring-failed' });
        }
      }
    };

    switch (action.type) {
      case 'request-spec':
        await comment(buildSpecRequest({ assigned: action.agent, config: ctx.config }), 'comment:spec-request');
        await assign(action.agent);
        await ring(action.agent, 'To do', { round: 'R1', tier: 'a', attempt: 1, hash: ctx.facts.bodyHash, author: 'none' });
        break;
      case 'request-review': {
        // An edit closes the round it was made in (PIPE-V2-D-REV4-002). Mark that round closed by the edit, and
        // name it when a self-vote on the new hash was ignored, so the issue shows why the round ended there.
        const edited = plan ? lastRoundEdit(plan.derived) : null;
        if (edited) {
          const label = currentRound(reviewsSoFar);
          const selfVote = (plan.ignored || []).some((v) => v.hash === edited.hash);
          await writeMarker({
            event: 'close',
            round: label?.round,
            tier: label?.tier,
            identity: edited.type,
            brand: brandOf(edited.type),
            hash: edited.hash,
            verdict: selfVote ? 'edit-self-vote' : 'edit',
          });
        }
        await comment(
          buildReviewRequest({ hash: action.hash, assigned: action.agent, config: ctx.config }),
          'comment:review-request',
        );
        await assign(action.agent);
        await ring(action.agent, 'In analysis', roundCtx(reviewsSoFar === null ? null : reviewsSoFar + 1, 1, action.hash, authorLabel(action.hash)));
        break;
      }
      case 'reassign': {
        const inReview = action.stage === 'In analysis';
        const held = inReview ? ctx.facts.review : ctx.facts.spec;
        const history = [...new Set([...(held?.timedOut || []), ...(held?.assignedTo ? [held.assignedTo] : [])])];
        const body = inReview
          ? buildReviewRequest({
              hash: ctx.facts.review.requestedHash,
              assigned: action.agent,
              history,
              config: ctx.config,
            })
          : buildSpecRequest({ assigned: action.agent, history, config: ctx.config });
        const failedId = held?.assignedTo || null;
        const failure = action.failureClass;
        // A ring failure is marked where it happens (in ring), so it is not marked twice here.
        if (failedId && failure && failure !== 'ring-failed') {
          await writeMarker({
            event: 'fail',
            round: inReview ? currentRound(reviewsSoFar)?.round : 'R1',
            tier: inReview ? currentRound(reviewsSoFar)?.tier : 'a',
            identity: failedId,
            brand: brandOf(failedId),
            attempt: action.attempts ?? 1,
            hash: inReview ? ctx.facts.review?.requestedHash : ctx.facts.bodyHash,
            failure,
          });
        }
        await editComment(held.commentId, body, `edit:${inReview ? 'review' : 'spec'}-request`);
        await assign(action.agent);
        const retryHash = inReview ? ctx.facts.review?.requestedHash : ctx.facts.bodyHash;
        const retryRound = inReview ? currentRound(reviewsSoFar) : { round: 'R1', tier: 'a' };
        await ring(action.agent, action.stage, {
          round: retryRound?.round ?? null,
          tier: retryRound?.tier ?? null,
          attempt: (action.attempts ?? 0) + 1,
          hash: retryHash,
          author: inReview ? authorLabel(retryHash) : 'none',
        });
        break;
      }
      case 'wake-stage-agent':
        // Hand off before the wake marker: a runner cap must not mark the human reply handled (#2556 P1).
        await assign(action.agent);
        await ring(action.agent, ctx.facts.stage);
        if (applied.some((line) => line.startsWith('doorbell:'))) {
          await comment(
            buildWake({ commentId: action.commentId, agent: action.agent, config: ctx.config }),
            'comment:wake',
          );
        }
        break;
      case 'ring-doorbell': {
        const blockedQueued = action.row === 'blocked.runner-queued';
        const inReview = action.stage === 'In analysis';
        const current = inReview ? currentRound(reviewsSoFar) : { round: 'R1', tier: 'a' };
        await ring(
          action.agent,
          action.stage,
          blockedQueued
            ? null
            : {
                round: current?.round ?? null,
                tier: current?.tier ?? null,
                attempt: ((inReview ? ctx.facts.review?.timedOut : ctx.facts.spec?.timedOut)?.length ?? 0) + 1,
                hash: inReview ? ctx.facts.review?.requestedHash : ctx.facts.bodyHash,
                author: inReview ? authorLabel(ctx.facts.review?.requestedHash) : 'none',
              },
        );
        break;
      }
      case 'launch': {
        let attempts = action.attempts;
        let run = null;
        let failure = null;
        // Recorded before the handoff (a failure here throws before anything starts, so the next tick retries).
        const launchPurpose = action.purpose || 'delivery';
        const launchStage = action.stage || (launchPurpose === 'babysit' ? 'babysit' : undefined);
        await comment(buildLaunchPending({ agent: action.agent, purpose: launchPurpose }), 'comment:launch-pending');
        try {
          // The launcher marks the issue `busy` before the handoff; the plan shows that request too.
          calls.push({ method: 'POST', path: `${base}/labels`, body: { labels: ['busy'] } });
          run = ctx.dryRun
            ? { runId: 'dry-run', agentUrl: '' }
            : await ctx.launchFn({
                agent: action.agent,
                method: action.method,
                purpose: launchPurpose,
                stage: launchStage,
                config: ctx.config,
              });
          calls.push({ method: 'POST', path: 'cursor:/v1/agents', body: { agent: action.agent, method: action.method } });
        } catch (error) {
          failure = error;
        }
        // Only the launch call is guarded: a run that started must be recorded, never retried as a failure.
        if (failure) {
          attempts = (action.attempts || 0) + 1;
          await comment(buildLaunchFailed({ agent: action.agent, reason: failure.message }), 'comment:launch-failed');
          applied.unshift(`launch-failed:${action.agent}`);
        } else {
          await comment(
            buildLaunchRecord({
              runId: run.runId,
              agent: action.agent,
              agentUrl: run.agentUrl,
              purpose: launchPurpose,
              stage: launchStage,
            }),
            'comment:launch',
          );
          applied.unshift(`launch:${action.agent}`);
        }
        // The launch is one of the failed runs until the agent reports busy, so record the count now.
        action = { ...action, attempts };
        break;
      }
      case 'launch-aat': {
        let run = null;
        let failure = null;
        // A doorbell run needs a nonce like a round doorbell does: the Claude runner refuses to dispatch without one.
        const nonce = randomNonceHex();
        try {
          run = ctx.dryRun
            ? { runId: 'dry-run' }
            : await ctx.launchFn({
                agent: action.agent,
                stage: 'acceptance',
                mergeSha: action.mergeSha,
                purpose: 'doorbell',
                nonce,
              });
          calls.push({ method: 'POST', path: 'cursor:/v1/agents', body: { agent: action.agent, stage: 'acceptance' } });
        } catch (error) {
          failure = error;
        }
        if (failure) {
          // The reason is public, so the nonce is removed from it before it is posted.
          const reason = String(failure?.message ?? failure).split(nonce).join('[redacted]');
          await comment(
            buildAatLaunch({ mergeSha: action.mergeSha, failed: true, reason, agent: action.agent }),
            'comment:aat-launch-failed',
          );
          applied.unshift(`aat-launch-failed:${action.agent}`);
          const { acceptance, acceptanceFailReason, ...rest } = action;
          action = rest;
        } else {
          await comment(
            buildAatLaunch({ mergeSha: action.mergeSha, runId: run.runId, agent: action.agent }),
            'comment:aat-launch',
          );
          applied.unshift(`aat-launch:${action.agent}`);
        }
        break;
      }
      case 'aat-relaunch': {
        let failure = null;
        try {
          if (!ctx.dryRun) {
            await ctx.launchFn({ agent: action.agent, method: action.method, scopeRelaunchSha: action.mergeSha });
          }
          calls.push({ method: 'POST', path: 'cursor:/v1/agents', body: { agent: action.agent, method: action.method } });
        } catch (error) {
          failure = error;
        }
        await comment(
          buildAatRelaunch({ mergeSha: action.mergeSha, failed: Boolean(failure) }),
          failure ? 'comment:aat-relaunch-failed' : 'comment:aat-relaunch',
        );
        applied.unshift(`${failure ? 'aat-relaunch-failed' : 'aat-relaunch'}:${action.agent}`);
        break;
      }
      case 'aat-waive': {
        const waiveAcceptance = action.waiveAcceptance || action.acceptance;
        await comment(
          buildAatWaive({ mergeSha: action.mergeSha, acceptance: waiveAcceptance, source: action.source }),
          'comment:aat-waive',
        );
        break;
      }
      case 'aat-reset':
        await comment(buildAatReset({ mergeSha: action.mergeSha }), 'comment:aat-reset');
        break;
      case 'request-intent-review':
        await comment(
          buildIntentReviewRequest({
            agent: action.agent,
            issueNumber: ctx.issueNumber,
            prNumbers: ctx.facts.delivery?.mergedPrNumbers,
            mergeSha: ctx.facts.delivery?.lastMergeSha,
            config: ctx.config,
          }),
          'comment:intent-review',
        );
        await assign(action.agent);
        await ring(action.agent, 'In Main');
        break;
      case 'reopen':
        await request('PATCH', base, { state: 'open' });
        applied.push('reopen');
        await comment(buildReopened({ stage: action.stage }), 'comment:reopened');
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
        // The resume is recorded even when it failed (`ok=0`): the next tick retries it on the launch backoff.
        await comment(buildResume({ agent: action.agent, ok }), 'comment:resume');
        applied.unshift(`${ok ? 'resume' : 'resume-failed'}:${action.agent}`);
        break;
      }
      case 'set-stage':
        if (action.to === 'Done') {
          await deleteBusyLabel();
        } else if (action.to !== 'In progress') {
          // Doorbell work (spec, review) ends on stage advance; delivery keeps `busy` until In progress ack.
          await deleteBusyLabel();
          applied.push('labels:busy-removed');
        }
        if (action.row === 'todo.dor-pass') {
          await writeMarker({
            event: 'close',
            round: 'R1',
            tier: 'a',
            identity: ctx.facts.spec?.assignedTo || null,
            brand: brandOf(ctx.facts.spec?.assignedTo),
            attempt: 1,
            hash: ctx.facts.bodyHash,
            verdict: 'spec',
          });
        }
        if (action.row === 'analysis.converged') {
          const current = currentRound(reviewsSoFar);
          await writeMarker({
            event: 'close',
            round: current?.round,
            tier: current?.tier,
            identity: action.evidence?.approvedBy?.[0] || null,
            brand: brandOf(action.evidence?.approvedBy?.[0]),
            hash: action.evidence?.hash,
            verdict: 'converged',
          });
        }
        if (action.to === 'In progress' && action.row === 'ready.launched' && ctx.facts.launch?.runId) {
          await comment(buildLaunchAcked({ runId: ctx.facts.launch.runId }), 'comment:launch-acked');
        }
        break;
      case 'release-hold':
        await comment(buildRelease({ by: action.by, from: action.from, cause: action.cause }), 'comment:release');
        break;
      case 'set-blocked': {
        await deleteBusyLabel();
        applied.push('labels:busy-removed');
        if (isEngineHold(action.reason)) {
          await comment(buildHold({ reason: action.reason, row: action.row }), 'comment:hold');
        }
        if (ctx.facts.stage === 'In analysis' && ctx.facts.review?.requestedHash) {
          const current = currentRound(reviewsSoFar);
          await writeMarker({
            event: 'close',
            round: current?.round,
            tier: current?.tier,
            hash: ctx.facts.review.requestedHash,
            verdict: action.reason,
          });
        }
        break;
      }
      case 'none':
        break;
      default:
        return { applied: [`unsupported:${action.type}`], calls };
    }

    const writes = buildWrites({ action, parsed: ctx.parsed });
    const patch = {};
    if (Object.keys(writes).length > 0) {
      let parsedForPatch = ctx.parsed;
      if (!ctx.dryRun) {
        const issue = await request('GET', base);
        parsedForPatch = parseIssueFields(issue, ctx.fields);
      }
      patch.issue_field_values = buildIssueFieldPatch(ctx.fields, writes, parsedForPatch);
    }
    if (action.type === 'set-stage' && action.close) {
      patch.state = 'closed';
      patch.state_reason = 'completed';
    }
    if (Object.keys(patch).length > 0) {
      if (Object.prototype.hasOwnProperty.call(writes, 'acceptance')) {
        await comment(
          buildAatStateMarker({
            acceptance: writes.acceptance,
            acceptanceFailReason: writes.acceptanceFailReason,
          }),
          'comment:aat-state',
        );
      }
      await request('PATCH', base, patch);
      applied.push(`fields:${Object.keys(writes).join(',') || 'state'}`);
    }
    return { applied, calls };
  } catch (error) {
    // Some requests may already have gone out; hand what was done to the caller's error log.
    if (error && typeof error === 'object') {
      error.applied = applied;
    }
    throw error;
  }
}

module.exports = { buildWrites, doorbellAssignees, applyAction };
