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
 *   agentLastUsed   { id: epoch ms } for least-recently-used pickup (in-tick)
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

const {
  agentLogins,
  agentActsAs,
  launchableAgents,
  resolveAgent,
  startableIds,
  entryId,
  entryActsAs,
} = require('./issue_pipeline_v2_config');

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

/**
 * The agent a wake rings. The holder is used only when the engine can start them. Otherwise the
 * least recently used startable agent, or null when none is startable.
 */
function wakeAgent(facts, stage, config) {
  const holder =
    stage === 'To do' ? facts.spec?.assignedTo : stage === 'In analysis' ? facts.review?.assignedTo : null;
  const startable = startableIds(config);
  if (holder && startable.includes(holder)) {
    return holder;
  }
  return pickAgent(startable, facts);
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

/** Shared timeout step for spec and review pickup. `eligible` is the startable pool for this request. */
function pickupTimeout({ state, eligible, facts, config, stage, rowPrefix }) {
  const timeoutMs = config.limits.reviewTimeoutMin * MIN;
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
      row: `${rowPrefix}.reassign`,
    };
  }
  const held = state.assignedTo;
  const startable = new Set(startableIds(config));
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
      ...(held ? { attempts: skipped.size } : {}),
      row: held ? `${rowPrefix}.reassign` : `${rowPrefix}.assign`,
    };
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
  const logins = startableIds(config);
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

function voterKey(vote, config) {
  if (vote.agentId) {
    return vote.agentId;
  }
  const matches = (config.agents || []).filter((agent) => entryActsAs(agent) === vote.login);
  return matches.length === 1 ? entryId(matches[0]) : vote.login;
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
    const key = voterKey(vote, config);
    voted.add(key);
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

  const ids = startableIds(config);
  let eligible = ids.filter((id) => agentActsAs(config, id) !== editor && !voted.has(id));
  if (eligible.length === 0 && editorIsAgent) {
    const editorId = resolveAgent(config, editor)?.id;
    if (editorId && ids.includes(editorId)) {
      eligible = [editorId];
    }
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
  // `busy` is set by the launcher before the handoff, so it also covers a run whose record comment
  // was lost: never launch again over an issue that is already busy.
  if (launch.busy) {
    return setStage('In progress', 'ready.launched', { evidence: { runId: launch.runId || null } });
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
    return setBlocked('launch-failed', 'ready.no-capable-agent');
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
    if (!delivery.engineLaunched) {
      return none('progress.hand-driven'); // not started by the engine, so not the engine's to restart
    }
    if (delivery.resumed) {
      return setBlocked('stalled', 'progress.stalled');
    }
    const method = facts.deliveryMethod || 'PR';
    const capable = launchableAgents(config, method);
    return capable.length === 0
      ? setBlocked('stalled', 'progress.no-launchable-agent')
      : { type: 'resume', agent: pickAgent(capable, facts), method, row: 'progress.resume' };
  }
  return none('progress.working');
}

function decideInMain(facts, config) {
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
  if (facts.closed) {
    // Closed while delivery was under way (a merge auto-closed it, for example): an issue must stay
    // open until Done. Once only: a second close is deliberate. `not_planned` is always deliberate.
    const underway = ['In progress', 'In Main', 'In UAT'].includes(stage);
    return underway && facts.closeReason === 'completed' && !facts.reopenedBefore
      ? { type: 'reopen', stage, row: 'closed.reopen' }
      : none('closed');
  }
  if (facts.blocked) {
    // Only a human comment wakes a blocked issue, once per comment; the engine never clears the flag.
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
