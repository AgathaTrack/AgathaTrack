'use strict';

const {
  fetchIssue,
  assignIssue,
  setLabels,
  updateProjectStatus,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const { defaultState, DEFAULT_ROUND_CAP, DELIVERY_LABELS } = require('./issue_pipeline_state');
const { upsertPipelineState } = require('./issue_pipeline_state_load');
const { hasLabel } = require('./issue_pipeline_gate');
const OWNER_LOGIN = 'KanopeeKa';

const REVIEW_MARKER = '<!-- pipeline-review -->';

function otherBot(login) {
  if (login === 'pawpet-claude') {
    return 'pawpet-bot';
  }
  if (login === 'pawpet-bot') {
    return 'pawpet-claude';
  }
  return 'pawpet-bot';
}

/**
 * Decide next handoff after a review round (pure).
 */
function decideReviewHandoff({
  state,
  liveBodySha,
  reviewer,
  verdict,
  bodyEditedThisRound,
  roundCap = DEFAULT_ROUND_CAP,
}) {
  const round = state.round || 0;
  const nextRound = round + 1;
  const verdicts = { ...(state.verdicts || {}), [reviewer]: verdict };

  if (verdict === 'red' || bodyEditedThisRound) {
    if (nextRound >= roundCap) {
      return {
        kind: 'needs-owner',
        owner_reason: 'no-convergence',
        round: nextRound,
        verdicts,
        body_sha: liveBodySha,
      };
    }
    return {
      kind: 'continue-analysis',
      assignee: otherBot(reviewer),
      round: nextRound,
      verdicts,
      body_sha: liveBodySha,
      last_assignee: reviewer,
      converged_at: null,
    };
  }

  const other = reviewer === 'pawpet-claude' ? 'pawpet-bot' : 'pawpet-claude';
  const otherVerdict = verdicts[other];
  if (verdict === 'green' && otherVerdict === 'green' && state.body_sha === liveBodySha) {
    return {
      kind: 'converged',
      assignee: 'pawpet-bot',
      status: 'Ready',
      round: nextRound,
      verdicts,
      body_sha: liveBodySha,
      last_assignee: reviewer,
      converged_at: new Date().toISOString(),
    };
  }

  if (nextRound >= roundCap) {
    return {
      kind: 'needs-owner',
      owner_reason: 'no-convergence',
      round: nextRound,
      verdicts,
      body_sha: liveBodySha,
    };
  }

  return {
    kind: 'continue-analysis',
    assignee: otherBot(reviewer),
    round: nextRound,
    verdicts,
    body_sha: liveBodySha,
    last_assignee: reviewer,
    converged_at: null,
  };
}

function buildStateMarker(state) {
  return `<!-- agent-state: ${JSON.stringify(state)} -->`;
}

/**
 * State after a reopen. `last_assignee` is kept: the newly assigned agent is the other bot, and
 * the review lane refuses a reviewer equal to `last_assignee` (#2363 review: writing the new
 * assignee here blocked every reopened issue as self-review).
 */
function buildReopenState(state, liveBodySha, round) {
  return {
    ...defaultState(),
    ...state,
    round: round ?? 0,
    body_sha: liveBodySha,
    verdicts: {},
    converged_at: null,
    delivery: null,
  };
}

/**
 * Pure reopen decision (github-issue-workflow §Reopening In Analysis, step 5).
 * Owner product edit → round 0. Agent reopen reaching the cap → needs-owner.
 */
function decideReopen({ state, ownerEdited, roundCap = DEFAULT_ROUND_CAP }) {
  const assignee = otherBot(state.last_assignee || 'pawpet-claude');
  if (ownerEdited) {
    return { kind: 'reopen', assignee, round: 0 };
  }
  const round = (state.round || 0) + 1;
  if (round >= roundCap) {
    return { kind: 'needs-owner', owner_reason: 'no-convergence-reopen', round };
  }
  return { kind: 'reopen', assignee, round };
}

async function applyReopenAnalysis({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  state,
  liveBodySha,
  ownerEdited = false,
  dryRun,
}) {
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const decision = decideReopen({ state, ownerEdited });
  const deliveryRemoves = (issue.labels?.nodes || [])
    .map((n) => n.name)
    .filter((n) => DELIVERY_LABELS.has(n));

  if (decision.kind === 'needs-owner') {
    const capState = buildReopenState(state, liveBodySha, decision.round);
    if (dryRun) {
      return { dryRun: true, action: 'reopen-analysis', decision, deliveryRemoves };
    }
    if (deliveryRemoves.length > 0) {
      await setLabels(owner, repo, issueNumber, [], deliveryRemoves, token);
    }
    return applyNeedsOwnerConvergence({
      owner,
      repo,
      issueNumber,
      token,
      projectsPat,
      projectId,
      statusFieldId,
      assignToken,
      state: capState,
      liveBodySha,
      ownerReason: decision.owner_reason,
      dryRun: false,
    });
  }

  const { assignee } = decision;
  const nextState = buildReopenState(state, liveBodySha, decision.round);

  if (dryRun) {
    return { dryRun: true, action: 'reopen-analysis', assignee, nextState, deliveryRemoves };
  }

  if (deliveryRemoves.length > 0) {
    await setLabels(owner, repo, issueNumber, [], deliveryRemoves, token);
  }

  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: REVIEW_MARKER,
    body: `${REVIEW_MARKER}
## Reopened for analysis

Body or delivery mismatch — delivery labels removed, \`verdicts\` cleared${ownerEdited ? ', round reset (owner edit)' : ''}.`,
    token,
  });

  await upsertPipelineState({
    owner,
    repo,
    issueNumber,
    token,
    assignToken,
    state: nextState,
    summaryLine: 'Reopened for analysis',
  });

  await assignIssue(owner, repo, issueNumber, assignee, assignToken || token);
  if (projectsPat && projectId && statusFieldId) {
    const refreshed = await fetchIssue(owner, repo, issueNumber, token);
    await updateProjectStatus({
      issue: refreshed,
      projectId,
      statusFieldId,
      statusName: 'In Analysis',
      projectsPat,
    });
  }

  return { assignee, status: 'In Analysis', state: nextState };
}

async function applyNeedsOwnerConvergence({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  state,
  liveBodySha,
  ownerReason = 'no-convergence',
  dryRun,
}) {
  const nextState = {
    ...state,
    round: state.round || DEFAULT_ROUND_CAP,
    body_sha: liveBodySha,
    owner_reason: ownerReason,
    converged_at: null,
  };

  if (dryRun) {
    return { dryRun: true, action: 'needs-owner-convergence', nextState };
  }

  await setLabels(owner, repo, issueNumber, ['needs-owner'], [], token);
  await assignIssue(owner, repo, issueNumber, OWNER_LOGIN, assignToken || token);
  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: REVIEW_MARKER,
    body: `${REVIEW_MARKER}
## Review round cap

\`round >= ${DEFAULT_ROUND_CAP}\` (\`${ownerReason}\`) — assigned @${OWNER_LOGIN} with \`needs-owner\`.`,
    token,
  });

  await upsertPipelineState({
    owner,
    repo,
    issueNumber,
    token,
    assignToken,
    state: nextState,
    summaryLine: 'Review round cap',
  });

  return { assignee: OWNER_LOGIN, labels: ['needs-owner'], state: nextState };
}

/**
 * Stub review for P5 (until Claude/Cursor worker wires): reads PIPELINE_REVIEW_VERDICT env
 * default `green` with no body edit — for soak, set verdict=red to exercise handoff.
 */
async function applyReviewStub({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  state,
  liveBodySha,
  reviewer,
  dryRun,
  labels = [],
  body = '',
}) {
  const stubExplicit = process.env.PIPELINE_REVIEW_STUB === 'true';
  const verdictEnv = process.env.PIPELINE_REVIEW_VERDICT;
  if (!dryRun) {
    if (!stubExplicit && !verdictEnv) {
      return { action: 'review', skipped: true, reason: 'no-review-worker' };
    }
    if (stubExplicit && !hasLabel(labels, 'pipeline-beta')) {
      return { action: 'review', skipped: true, reason: 'stub-not-pipeline-beta' };
    }
  }
  let verdict = String(verdictEnv || 'green').toLowerCase() === 'red' ? 'red' : 'green';
  // #2363 §4.2: review rounds own the agent-paths block; a Green without one is a Red.
  // Lazy require: issue_pipeline_delivery imports this module.
  const { parseAgentPathsBlock } = require('./issue_pipeline_delivery');
  const pathsBlock = parseAgentPathsBlock(body);
  const missingPaths = verdict === 'green' && !pathsBlock.ok;
  if (missingPaths) {
    verdict = 'red';
  }
  const bodyEdited = process.env.PIPELINE_REVIEW_BODY_EDIT === 'true';
  if ((state.last_assignee || null) === reviewer) {
    return { action: 'review', skipped: true, reason: 'self-review-blocked' };
  }
  const plan = decideReviewHandoff({
    state,
    liveBodySha,
    reviewer,
    verdict,
    bodyEditedThisRound: bodyEdited,
  });

  if (dryRun) {
    return { dryRun: true, action: 'review', plan, missingPaths };
  }

  if (plan.kind === 'needs-owner') {
    return applyNeedsOwnerConvergence({
      owner,
      repo,
      issueNumber,
      token,
      projectsPat,
      projectId,
      statusFieldId,
      assignToken,
      state: { ...state, round: plan.round, verdicts: plan.verdicts },
      liveBodySha,
      dryRun: false,
    });
  }

  const nextState = {
    ...defaultState(),
    ...state,
    round: plan.round,
    verdicts: plan.verdicts,
    body_sha: plan.body_sha,
    last_assignee: plan.last_assignee,
    converged_at: plan.converged_at || null,
    stuck: state.stuck || 0,
  };

  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: REVIEW_MARKER,
    body: `${REVIEW_MARKER}
## Peer review (${reviewer})

Verdict: **${verdict.toUpperCase()}**${bodyEdited ? ' (body edited)' : ''}${
  missingPaths ? ` — no parseable \`agent-paths\` block (${pathsBlock.reason})` : ''
}.`,
    token,
  });

  await upsertPipelineState({
    owner,
    repo,
    issueNumber,
    token,
    assignToken,
    state: nextState,
    summaryLine: `Peer review (${reviewer}): ${verdict.toUpperCase()}`,
  });

  await assignIssue(owner, repo, issueNumber, plan.assignee, assignToken || token);

  if (plan.kind === 'converged' && projectsPat && projectId && statusFieldId) {
    const refreshed = await fetchIssue(owner, repo, issueNumber, token);
    await updateProjectStatus({
      issue: refreshed,
      projectId,
      statusFieldId,
      statusName: 'Ready',
      projectsPat,
    });
  }

  return { plan, state: nextState, assignee: plan.assignee };
}

module.exports = {
  REVIEW_MARKER,
  otherBot,
  decideReviewHandoff,
  decideReopen,
  buildReopenState,
  applyReopenAnalysis,
  applyNeedsOwnerConvergence,
  applyReviewStub,
};