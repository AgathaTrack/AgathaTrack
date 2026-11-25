'use strict';

/**
 * Pipeline v2 decision function (#2385): `decide(facts, config)` is pure. It returns one action
 * descriptor per issue per tick, or `{ type: 'none', reason }`. Readers build `facts`; adapters
 * apply the action. Nothing here touches GitHub.
 *
 * facts (all optional fields default to "nothing happened yet"):
 *   mode            'off' | 'dry-run' | 'on'
 *   now             epoch ms
 *   onBoard         issue is on the Pawpet board
 *   labels          string[]
 *   stage           raw `Stage` option name ('' when the board item has none)
 *   blocked         raw `Blocked` option name ('' when empty)
 *   humanCommentSinceBlock  a human with write access commented after `Blocked` was set
 *   escalation      an AGENTS.md escalation item was hit (agent-reported)
 *   followUp        { depth } when the issue is an intent-review follow-up
 *   bodyHash        hash of the current body
 *   lastBodyEditor  login of the last body editor, or null
 *   totalVotes      votes cast in To do / In analysis (reactions + agent body edits)
 *   roundRobinAfter id last assigned on the board (newest v2:launch, then earlier picks this tick)
 *   roundRobinOrder startable ids in config order; the ring the cursor walks
 *   spec            { requestedAt, assignedTo, timedOut[], passedBy }
 *   review          { requestedHash, requestedAt, assignedTo, timedOut[], votes[{login,vote,hash}] }
 *   wip             In progress issues the engine launched (hand-driven and manual-only excluded)
 *   deliveryMethod  'PR' | 'light-plan' | 'execute-plan'
 *   launch          { runId, startedAt, busy, failures, lastFailureAt }
 *   delivery        { busy, dodComplete, openLinkedPrs, mergedIntoMain, lastActivityAt, resumed }
 *   intentReview    { requested }
 *   prAuthors       logins that authored the issue's linked PRs
 *   uatContainsLatestMerge, prodContainsLatestMerge   booleans
 */

const { missionGuard } = require('./issue_pipeline_mission');
const { launchableAgents, resolveAgent, nextInLine, startableIds, reviewPoolIds } = require('./issue_pipeline_v2_config');
const { aatGateOn, acceptanceInMain, acceptanceInProgress } = require('./issue_pipeline_v2_acceptance');
const { decideRound, cursorLastUsed } = require('./issue_pipeline_v2_rounds');
const { decideEngineHold, holdCleared, launchBackoffMs } = require('./issue_pipeline_v2_holds');

const STAGES = [
  'Backlog',
  'To do',
  'In analysis',
  'Ready',
  'In progress',
  'In Main',
  'In UAT',
  'Done',
];

const MIN = 60 * 1000;
/** A `busy` doorbell holds a pickup for this many review timeouts, then the pickup moves on. */
const BUSY_HOLD_TIMEOUTS = 2;
const HOUR = 60 * MIN;

/** Canonical stage name; empty reads as Backlog; unknown names return null. */
function canonicalStage(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) {
    return 'Backlog';
  }
  return STAGES.find((stage) => stage.toLowerCase() === text) || null;
}

/**
 * The agent a wake rings. The holder is used only when the engine can start them. Otherwise the
 * next startable agent in the round robin, or null when none is startable.
 */
function wakeAgent(facts, stage, config) {
  const holder =
    stage === 'To do' ? facts.spec?.assignedTo : stage === 'In analysis' ? facts.review?.assignedTo : null;
  // Only spec and review pickup is tier-a-only. Blocked delivery and intent-review wakes keep every startable id.
  const startable = stage === 'To do' || stage === 'In analysis' ? reviewPoolIds(config) : startableIds(config);
  if (holder && startable.includes(holder)) {
    return holder;
  }
  return pickAgent(startable, facts);
}

function none(reason) {
  return { type: 'none', reason };
}

/** No agent can take the work: a board-level error in the run summary, never a flag on the issue. */
function noAgent(row) {
  return { type: 'none', reason: row, boardError: true };
}

function setStage(to, row, extra = {}) {
  return { type: 'set-stage', to, row, ...extra };
}

function setBlocked(reason, row) {
  return { type: 'set-blocked', reason, row };
}

/** Next startable id after the board cursor. Candidates stay in config order. */
function pickAgent(candidates, facts) {
  return nextInLine(candidates, facts.roundRobinAfter, facts.roundRobinOrder || candidates);
}

function timedOutSet(state, now, timeoutMs) {
  const set = new Set(state.timedOut || []);
  if (state.assignedTo && state.requestedAt && now - state.requestedAt >= timeoutMs) {
    set.add(state.assignedTo);
  }
  return set;
}

/** Retry a doorbell deferred at Claude runner cap; never over an active `busy` hold. */
function runnerQueuedRetry({ facts, config, stage, rowPrefix, assignedTo, requestedAt, allowed }) {
  const timeoutMs = config.limits.reviewTimeoutMin * MIN;
  const labels = facts.labels || [];
  // `allowed` is the caller's pool: the tier-a review pool for spec and review, every startable id for intent review.
  const startable = new Set(allowed);
  const withinPickupTimeout = requestedAt && facts.now - requestedAt < timeoutMs;
  if (
    labels.includes('queued') &&
    !labels.includes('busy') &&
    assignedTo &&
    startable.has(assignedTo) &&
    withinPickupTimeout
  ) {
    return {
      type: 'ring-doorbell',
      agent: assignedTo,
      stage,
      row: `${rowPrefix}.runner-queued`,
    };
  }
  return null;
}

/** Shared timeout step for spec and review pickup. `eligible` is the startable pool for this request. */
function pickupTimeout({ state, eligible, facts, config, stage, rowPrefix }) {
  const timeoutMs = config.limits.reviewTimeoutMin * MIN;
  const startable = new Set(reviewPoolIds(config));
  const queuedRetry = runnerQueuedRetry({
    facts,
    config,
    stage,
    rowPrefix,
    assignedTo: state.assignedTo,
    requestedAt: state.requestedAt,
    allowed: startable,
  });
  if (queuedRetry) {
    return queuedRetry;
  }
  if (state.ringFailed && state.assignedTo) {
    const timedOut = new Set([...(state.timedOut || []), state.assignedTo]);
    const remaining = eligible.filter((login) => !timedOut.has(login));
    const next = pickAgent(remaining, facts);
    if (!next) {
      return setBlocked('stalled', `${rowPrefix}.stalled`);
    }
    return {
      type: 'reassign',
      stage,
      agent: next,
      attempts: timedOut.size,
      failureClass: 'ring-failed',
      row: `${rowPrefix}.reassign`,
    };
  }
  const held = state.assignedTo;
  // No assignee yet, or the assignee is not one the engine can start: pick now. Waiting out
  // reviewTimeoutMin for pawpet-claude is the churn this interim fix exists to stop.
  // `eligible` is who may be asked next, which is narrower than startable (it drops the editor
  // and anyone who has already voted), so a startable assignee still waits out the timeout.
  if (!held || !startable.has(held)) {
    const skipped = new Set(state.timedOut || []);
    if (held) skipped.add(held);
    const remaining = eligible.filter((login) => !skipped.has(login));
    const next = pickAgent(remaining, facts);
    if (!next) {
      return setBlocked('stalled', `${rowPrefix}.stalled`);
    }
    return {
      type: 'reassign',
      stage,
      agent: next,
      ...(held ? { attempts: skipped.size, failureClass: 'not-startable' } : {}),
      row: held ? `${rowPrefix}.reassign` : `${rowPrefix}.assign`,
    };
  }
  if (facts.now - state.requestedAt < timeoutMs) {
    return none(`${rowPrefix}.waiting`);
  }
  // Doorbell runs mark the issue `busy`; do not ring a second agent until that work finishes.
  // A doorbell run that ends without a vote never clears `busy` (the engine clears it only on a
  // stage advance or a Blocked write), so the hold lasts one extra timeout at most (soak-6, #2485).
  if ((facts.labels || []).includes('busy') && facts.now - state.requestedAt < BUSY_HOLD_TIMEOUTS * timeoutMs) {
    return none(`${rowPrefix}.waiting-busy`);
  }
  const timedOut = timedOutSet(state, facts.now, timeoutMs);
  const remaining = eligible.filter((login) => !timedOut.has(login));
  if (remaining.length === 0) {
    return setBlocked('stalled', `${rowPrefix}.stalled`);
  }
  return {
    type: 'reassign',
    stage,
    agent: pickAgent(remaining, facts),
    attempts: timedOut.size,
    failureClass: 'timeout',
    row: `${rowPrefix}.reassign`,
  };
}

function decideToDo(facts, config) {
  const spec = facts.spec || {};
  if (spec.passedBy) {
    return setStage('In analysis', 'todo.dor-pass', { evidence: { passedBy: spec.passedBy } });
  }
  const logins = reviewPoolIds(config);
  if (!spec.requestedAt) {
    return {
      type: 'request-spec',
      agent: pickAgent(logins, facts),
      row: 'todo.request',
    };
  }
  return pickupTimeout({
    state: spec,
    eligible: logins,
    facts,
    config,
    stage: 'To do',
    rowPrefix: 'todo',
  });
}

/** Translate a round-model action into the action the apply path writes. */
function toLiveAction(plan, facts) {
  if (plan.type === 'request-round') {
    const round = { round: plan.round, tier: plan.tier, fallback: plan.fallback };
    if (plan.attempt === 1) {
      return { type: 'request-review', hash: plan.hash, agent: plan.agent, row: plan.row, ...round };
    }
    return {
      type: 'reassign',
      stage: 'In analysis',
      agent: plan.agent,
      attempts: plan.attempt - 1,
      failureClass: plan.failureClass,
      row: plan.row,
      ...round,
    };
  }
  if (plan.type === 'set-stage') {
    return setStage(plan.to, plan.row, { evidence: plan.evidence });
  }
  if (plan.type === 'set-blocked') {
    return setBlocked(plan.reason, plan.row);
  }
  return none(plan.reason);
}

/**
 * In analysis is decided by the round model (PIPE-V2-D-REV3-002 to 005). The live action is the plan,
 * so a verified green from another run converges, and a silent or failed holder is reassigned.
 */
/**
 * A doorbell deferred at the runner cap (`queued`) has not started, so it is not a failed attempt: the same
 * holder is rung again while the pickup is inside its timeout. `busy` means a run is already in flight.
 */
function queuedRetry(facts, config, timeoutMs) {
  const review = facts.review || {};
  const labels = facts.labels || [];
  const pool = new Set(reviewPoolIds(config));
  const inside = review.requestedAt && facts.now - review.requestedAt < timeoutMs;
  if (
    labels.includes('queued') &&
    !labels.includes('busy') &&
    review.assignedTo &&
    pool.has(review.assignedTo) &&
    review.requestedHash === facts.bodyHash &&
    inside
  ) {
    return { type: 'ring-doorbell', agent: review.assignedTo, stage: 'In analysis', row: 'analysis.runner-queued' };
  }
  return null;
}

function decideInAnalysis(facts, config) {
  const timeoutMs = config.limits.reviewTimeoutMin * MIN;
  const retry = queuedRetry(facts, config, timeoutMs);
  if (retry) return retry;
  const plan = decideRound({
    bodyHash: facts.bodyHash,
    rounds: facts.rounds || [],
    now: facts.now,
    lastUsed: cursorLastUsed(facts.roundRobinOrder || startableIds(config), facts.roundRobinAfter),
    config,
    // A doorbell marked busy is still working: its silence window is doubled (soak-6, #2485).
    silenceMs: (facts.labels || []).includes('busy') ? BUSY_HOLD_TIMEOUTS * timeoutMs : timeoutMs,
    holderFailed: Boolean(facts.review?.ringFailed),
  });
  return toLiveAction(plan, facts);
}

const backoffDelayMs = launchBackoffMs;

function decideReady(facts, config) {
  const launch = facts.launch || {};
  const failures = launch.failures || 0;
  // `busy` is set by the launcher before the handoff, so it also covers a run whose record comment
  // was lost: never launch again over an issue that is already busy.
  if (launch.busy) {
    return setStage('In progress', 'ready.launched', { evidence: { runId: launch.runId || null } });
  }
  const ownerApprovedDelivery = (facts.labels || []).some(
    (label) => String(label).trim().toLowerCase() === 'owner-approved-delivery',
  );
  if (launch.riskyScopePreflight && !ownerApprovedDelivery) {
    return setBlocked('sensitive', 'ready.risky-scope');
  }
  if (launch.runId && facts.now - launch.startedAt < config.limits.ackWindowMin * MIN) {
    return none('ready.waiting-ack');
  }
  // A run without `busy` after the acknowledge window counts as one failed start.
  const failed = launch.runId ? failures + 1 : failures;
  if (failed > config.limits.launchBackoffMin.length) {
    return setBlocked('launch-failed', 'ready.launch-failed');
  }
  if (facts.wip >= config.limits.wip) {
    return none('ready.queued');
  }
  if (failed > 0) {
    const failedAt = launch.runId
      ? launch.startedAt + config.limits.ackWindowMin * MIN
      : launch.lastFailureAt;
    if (facts.now - failedAt < backoffDelayMs(failed, config)) {
      return none('ready.backoff');
    }
  }
  const capable = launchableAgents(config, facts.deliveryMethod);
  if (capable.length === 0) {
    return noAgent('ready.no-capable-agent');
  }
  return {
    type: 'launch',
    agent: pickAgent(capable, facts),
    method: facts.deliveryMethod,
    attempts: failed,
    row: 'ready.launch',
  };
}

function decideInProgress(facts, config) {
  const held = acceptanceInProgress(facts, config);
  if (held) return held;
  const delivery = facts.delivery || {};
  const finished =
    delivery.dodComplete &&
    (delivery.openLinkedPrs || 0) === 0 &&
    (delivery.mergedIntoMain || 0) >= 1 &&
    !delivery.busy;
  if (finished) {
    return setStage(
      'In Main',
      'progress.finished',
      aatGateOn(facts, config) ? {} : { then: ['request-intent-review'] },
    );
  }
  const inactive =
    delivery.lastActivityAt != null &&
    facts.now - delivery.lastActivityAt >= config.limits.stalledInactivityHours * HOUR;
  if (!delivery.busy || inactive) {
    if (!delivery.engineLaunched) {
      return none('progress.hand-driven'); // not started by the engine, so not the engine's to restart
    }
    if (delivery.resumed) {
      return setBlocked('stalled', 'progress.stalled');
    }
    // A resume that could not start is an infrastructure fault: it is retried on the launch backoff.
    const failedResumes = delivery.failedResumes || 0;
    if (failedResumes > config.limits.launchBackoffMin.length) {
      return setBlocked('launch-failed', 'progress.resume-failed');
    }
    if (failedResumes > 0 && facts.now - delivery.lastResumeFailureAt < backoffDelayMs(failedResumes, config)) {
      return none('progress.backoff');
    }
    const method = facts.deliveryMethod || 'PR';
    const capable = launchableAgents(config, method);
    return capable.length === 0
      ? noAgent('progress.no-launchable-agent')
      : { type: 'resume', agent: pickAgent(capable, facts), method, row: 'progress.resume' };
  }
  return none('progress.working');
}

function decideInMain(facts, config) {
  if (aatGateOn(facts, config)) return acceptanceInMain(facts, config);
  // An issue moved to In Main by hand may have no linked PR merged into `main`. There is then no
  // merge to review or to find in a deploy, and a request could never be satisfied: it would repeat
  // on every tick. Wait until a merge exists.
  if (!facts.delivery?.lastMergeSha) {
    return none('main.no-merge');
  }
  if (!facts.intentReview?.requested) {
    const startable = startableIds(config);
    const deliverer = facts.deliveryLaunchAgentId || null;
    const independent = deliverer ? startable.filter((id) => id !== deliverer) : startable;
    const pool = independent.length > 0 ? independent : startable;
    if (pool.length > 0) {
      return { type: 'request-intent-review', agent: pickAgent(pool, facts), row: 'main.intent-request' };
    }
    // Intent review is non-gating; still evaluate UAT when nobody is startable for a ring.
  } else {
    const intentRetry = runnerQueuedRetry({
      facts,
      config,
      stage: 'In Main',
      rowPrefix: 'main.intent',
      assignedTo: facts.intentReview.agent,
      requestedAt: facts.intentReview.requestedAt,
      allowed: startableIds(config),
    });
    if (intentRetry) {
      return intentRetry;
    }
  }
  if (facts.uatContainsLatestMerge) {
    return setStage('In UAT', 'main.uat');
  }
  return none('main.waiting-uat');
}

function decideInUat(facts) {
  if (facts.prodContainsLatestMerge) {
    return setStage('Done', 'uat.prod', { close: true });
  }
  return none('uat.waiting-prod');
}

/**
 * One action per issue per decision. Guards first, then holds, then the stage rows.
 * @returns {{ type: string, reason?: string, row?: string }}
 */
function decide(facts, config) {
  if (!facts.mode || facts.mode === 'off') {
    return none('mode-off');
  }
  if (!facts.onBoard) {
    return none('not-on-board');
  }
  if ((facts.labels || []).includes('manual-only')) {
    return none('manual-only');
  }
  const stage = canonicalStage(facts.stage);
  if (stage === null) {
    return none('unknown-stage');
  }
  // Scoped missions (e.g. analyse) must not reopen closed delivery issues or release holds past Ready.
  const missionBlock = missionGuard(stage, facts.mission);
  if (missionBlock) {
    return missionBlock;
  }
  if (facts.closed) {
    // Closed while delivery was under way (a merge auto-closed it, for example): an issue must stay
    // open until Done. Once only: a second close is deliberate. `not_planned` is always deliberate.
    const underway = ['In progress', 'In Main', 'In UAT'].includes(stage);
    return underway && facts.closeReason === 'completed' && !facts.reopenedBefore
      ? { type: 'reopen', stage, row: 'closed.reopen' }
      : none('closed');
  }
  if (facts.blocked) {
    // `paused` and `sensitive` are owner holds: nothing happens, a comment wakes nobody, until the owner clears them.
    const blockedHold = String(facts.blocked).trim().toLowerCase();
    if (blockedHold === 'paused') {
      return none('blocked.paused');
    }
    if (blockedHold === 'sensitive') {
      return none('blocked.sensitive');
    }
    // An engine hold (`stalled`, `launch-failed`) is re-evaluated on full facts and released when its cause is gone.
    const held = decideEngineHold(facts, config, decideStage);
    if (held) {
      return held;
    }
    // Otherwise only a human comment wakes a blocked issue, once per comment.
    const answered = (facts.wokenFor || []).includes(facts.humanCommentId);
    if (!(facts.humanCommentSinceBlock && !answered)) {
      return none(answered ? 'blocked.already-woken' : 'blocked');
    }
    const agent = wakeAgent(facts, stage, config);
    return agent
      ? {
          type: 'wake-stage-agent',
          stage,
          agent,
          commentId: facts.humanCommentId,
          row: 'blocked.wake',
        }
      : none('blocked.no-agent');
  }
  // A human cleared an engine hold: record the retry, so the stage's earlier attempts stop counting.
  if (holdCleared(facts)) {
    return { type: 'release-hold', by: 'human', from: facts.holds.hold.reason, row: 'blocked.cleared' };
  }
  return decideStage(facts, config);
}

/** The stage rows, for an issue that is not blocked (or an engine hold being re-evaluated). */
function decideStage(facts, config) {
  const stage = canonicalStage(facts.stage);
  const missionBlock = missionGuard(stage, facts.mission);
  if (missionBlock) {
    return missionBlock;
  }
  if (!String(facts.stage || '').trim() && facts.followUp) {
    return facts.followUp.depth <= config.limits.followUpMaxDepth
      ? setStage('To do', 'followup.todo')
      : setStage('Backlog', 'followup.too-deep');
  }
  if (facts.escalation) {
    return setBlocked('decision', 'any.escalation');
  }
  switch (stage) {
    case 'To do':
      return decideToDo(facts, config);
    case 'In analysis':
      return decideInAnalysis(facts, config);
    case 'Ready':
      return decideReady(facts, config);
    case 'In progress':
      return decideInProgress(facts, config);
    case 'In Main':
      return decideInMain(facts, config);
    case 'In UAT':
      return decideInUat(facts);
    default:
      return none(`stage-${stage.toLowerCase().replace(/ /g, '-')}`);
  }
}

module.exports = { STAGES, canonicalStage, decide, pickAgent };
