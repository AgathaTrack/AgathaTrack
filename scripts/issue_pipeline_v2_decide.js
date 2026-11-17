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
 *   agentLastUsed   { login: epoch ms } for least-recently-used pickup
 *   spec            { requestedAt, assignedTo, timedOut[], passedBy }
 *   review          { requestedHash, requestedAt, assignedTo, timedOut[], votes[{login,vote,hash}] }
 *   wip             issues currently In progress (manual-only excluded)
 *   deliveryMethod  'PR' | 'light-plan' | 'execute-plan'
 *   launch          { runId, startedAt, busy, failures, lastFailureAt }
 *   delivery        { busy, dodComplete, openLinkedPrs, mergedIntoMain, lastActivityAt, resumed }
 *   intentReview    { requested }
 *   prAuthors       logins that authored the issue's linked PRs
 *   uatContainsLatestMerge, prodContainsLatestMerge   booleans
 */

const { agentLogins } = require('./issue_pipeline_v2_config');

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
const HOUR = 60 * MIN;

/** Canonical stage name; empty reads as Backlog; unknown names return null. */
function canonicalStage(raw) {
  const text = String(raw || '').trim().toLowerCase();
  if (!text) {
    return 'Backlog';
  }
  return STAGES.find((stage) => stage.toLowerCase() === text) || null;
}

/** The agent a wake rings: the one holding the stage's request, else the least recently used. */
function wakeAgent(facts, stage, config) {
  const holder =
    stage === 'To do' ? facts.spec?.assignedTo : stage === 'In analysis' ? facts.review?.assignedTo : null;
  return holder || pickAgent(agentLogins(config), facts);
}

function none(reason) {
  return { type: 'none', reason };
}

function setStage(to, row, extra = {}) {
  return { type: 'set-stage', to, row, ...extra };
}

function setBlocked(reason, row) {
  return { type: 'set-blocked', reason, row };
}

/** Least recently used first; ties keep the order in the config file. */
function pickAgent(candidates, facts) {
  const used = facts.agentLastUsed || {};
  let best = null;
  for (const login of candidates) {
    if (best === null || (used[login] || 0) < (used[best] || 0)) {
      best = login;
    }
  }
  return best;
}

function timedOutSet(state, now, timeoutMs) {
  const set = new Set(state.timedOut || []);
  if (state.assignedTo && state.requestedAt && now - state.requestedAt >= timeoutMs) {
    set.add(state.assignedTo);
  }
  return set;
}

/** Shared timeout step for spec and review pickup. */
function pickupTimeout({ state, eligible, facts, config, stage, rowPrefix }) {
  const timeoutMs = config.limits.reviewTimeoutMin * MIN;
  if (!state.assignedTo) {
    const next = pickAgent(eligible, facts);
    return next
      ? { type: 'reassign', stage, agent: next, row: `${rowPrefix}.assign` }
      : none(`${rowPrefix}.no-agent`);
  }
  if (facts.now - state.requestedAt < timeoutMs) {
    return none(`${rowPrefix}.waiting`);
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
    row: `${rowPrefix}.reassign`,
  };
}

function decideToDo(facts, config) {
  const spec = facts.spec || {};
  if (spec.passedBy) {
    return setStage('In analysis', 'todo.dor-pass', { evidence: { passedBy: spec.passedBy } });
  }
  const logins = agentLogins(config);
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

function approvalsOnCurrentHash(facts, config) {
  const editor = facts.lastBodyEditor || null;
  const logins = new Set(agentLogins(config));
  const voters = new Set();
  const voted = new Set();
  for (const vote of facts.review?.votes || []) {
    if (vote.hash !== facts.bodyHash || !logins.has(vote.login)) {
      continue;
    }
    voted.add(vote.login);
    if (vote.vote === 'up' && vote.login !== editor) {
      voters.add(vote.login);
    }
  }
  return { editor, editorIsAgent: logins.has(editor), up: voters, voted };
}

function decideInAnalysis(facts, config) {
  const review = facts.review || {};
  const { editor, editorIsAgent, up, voted } = approvalsOnCurrentHash(facts, config);

  // Convergence is checked before the vote cap, so the sixth vote can still converge.
  const converged = editorIsAgent ? up.size >= 1 : up.size >= 2;
  if (converged) {
    return setStage('Ready', 'analysis.converged', {
      evidence: { hash: facts.bodyHash, editor, approvedBy: [...up] },
    });
  }
  if ((facts.totalVotes || 0) >= config.limits.noConvergenceVotes) {
    return setBlocked('no-convergence', 'analysis.no-convergence');
  }

  const logins = agentLogins(config);
  let eligible = logins.filter((login) => login !== editor && !voted.has(login));
  if (eligible.length === 0 && editorIsAgent) {
    eligible = [editor]; // nobody else left: the last editor revises
  }
  if (review.requestedHash !== facts.bodyHash) {
    return {
      type: 'request-review',
      hash: facts.bodyHash,
      agent: pickAgent(eligible, facts),
      row: 'analysis.request',
    };
  }
  return pickupTimeout({
    state: review,
    eligible,
    facts,
    config,
    stage: 'In analysis',
    rowPrefix: 'analysis',
  });
}

function backoffDelayMs(failures, config) {
  const list = config.limits.launchBackoffMin;
  return list[Math.min(failures, list.length) - 1] * MIN;
}

function decideReady(facts, config) {
  const launch = facts.launch || {};
  const failures = launch.failures || 0;
  if (launch.runId && launch.busy) {
    return setStage('In progress', 'ready.launched', { evidence: { runId: launch.runId } });
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
  const capable = config.agents
    .filter((agent) => agent.methods.includes(facts.deliveryMethod))
    .map((agent) => agent.login);
  if (capable.length === 0) {
    return setBlocked('launch-failed', 'ready.no-capable-agent');
  }
  return { type: 'launch', agent: pickAgent(capable, facts), method: facts.deliveryMethod, row: 'ready.launch' };
}

function decideInProgress(facts, config) {
  const delivery = facts.delivery || {};
  const finished =
    delivery.dodComplete &&
    (delivery.openLinkedPrs || 0) === 0 &&
    (delivery.mergedIntoMain || 0) >= 1 &&
    !delivery.busy;
  if (finished) {
    return setStage('In Main', 'progress.finished', { then: ['request-intent-review'] });
  }
  const inactive =
    delivery.lastActivityAt != null &&
    facts.now - delivery.lastActivityAt >= config.limits.stalledInactivityHours * HOUR;
  if (!delivery.busy || inactive) {
    return delivery.resumed
      ? setBlocked('stalled', 'progress.stalled')
      : { type: 'resume', row: 'progress.resume' };
  }
  return none('progress.working');
}

function decideInMain(facts, config) {
  if (!facts.intentReview?.requested) {
    const authors = new Set(facts.prAuthors || []);
    const independent = agentLogins(config).filter((login) => !authors.has(login));
    const pool = independent.length > 0 ? independent : agentLogins(config);
    return { type: 'request-intent-review', agent: pickAgent(pool, facts), row: 'main.intent-request' };
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
 * One action per issue per tick. Guards first, then the stage rows.
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
  if (facts.blocked) {
    // Only a human comment wakes a blocked issue, once per comment; the engine never clears the flag.
    const answered = (facts.wokenFor || []).includes(facts.humanCommentId);
    return facts.humanCommentSinceBlock && !answered
      ? {
          type: 'wake-stage-agent',
          stage,
          agent: wakeAgent(facts, stage, config),
          commentId: facts.humanCommentId,
          row: 'blocked.wake',
        }
      : none(answered ? 'blocked.already-woken' : 'blocked');
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
