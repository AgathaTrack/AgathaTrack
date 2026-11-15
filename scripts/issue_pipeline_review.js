'use strict';

const {
  fetchIssue,
  assignIssue,
  setLabels,
  updateProjectStatus,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const { defaultState, DEFAULT_ROUND_CAP, DELIVERY_LABELS } = require('./issue_pipeline_state');
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

  if (nextRound >= roundCap) {
    return {
      kind: 'needs-owner',
      owner_reason: 'no-convergence',
      round: nextRound,
      verdicts,
      body_sha: liveBodySha,
    };
  }

  if (verdict === 'red' || bodyEditedThisRound) {
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

function buildReopenState(state, liveBodySha, assignee, round) {
  return {
    ...defaultState(),
    ...state,
    round: round ?? 0,
    body_sha: liveBodySha,
    verdicts: {},
    converged_at: null,
    last_assignee: assignee,
  };
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
  dryRun,
}) {
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const assignee = otherBot(state.last_assignee || 'pawpet-claude');
  const nextState = buildReopenState(state, liveBodySha, assignee, (state.round || 0) + 1);

  const deliveryRemoves = (issue.labels?.nodes || [])
    .map((n) => n.name)
    .filter((n) => DELIVERY_LABELS.has(n));

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

Body or delivery mismatch — delivery labels removed, \`verdicts\` cleared.

${buildStateMarker(nextState)}`,
    token,
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
  dryRun,
}) {
  const nextState = {
    ...state,
    round: state.round || DEFAULT_ROUND_CAP,
    body_sha: liveBodySha,
    owner_reason: 'no-convergence',
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

\`round >= ${DEFAULT_ROUND_CAP}\` — assigned @${OWNER_LOGIN} with \`needs-owner\`.

${buildStateMarker(nextState)}`,
    token,
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
}) {
  const verdict = String(process.env.PIPELINE_REVIEW_VERDICT || 'green').toLowerCase();
  const bodyEdited = process.env.PIPELINE_REVIEW_BODY_EDIT === 'true';
  const plan = decideReviewHandoff({
    state,
    liveBodySha,
    reviewer,
    verdict: verdict === 'red' ? 'red' : 'green',
    bodyEditedThisRound: bodyEdited,
  });

  if (dryRun) {
    return { dryRun: true, action: 'review', plan };
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

Verdict: **${verdict.toUpperCase()}**${bodyEdited ? ' (body edited)' : ''}.

${buildStateMarker(nextState)}`,
    token,
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
  applyReopenAnalysis,
  applyNeedsOwnerConvergence,
  applyReviewStub,
};