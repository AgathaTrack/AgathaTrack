'use strict';

const {
  fetchIssue,
  assignIssue,
  updateProjectStatus,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const { bodySha, defaultState, PIPELINE_STATE_MARKER } = require('./issue_pipeline_state');
const { upsertPipelineState } = require('./issue_pipeline_state_load');

const INTAKE_MARKER = '<!-- pipeline-intake -->';

function buildIntakeComment(issueNumber, hints) {
  const hintBlock =
    hints?.length > 0
      ? `**Delivery hints from triage:** ${hints.join(', ')}\n\n`
      : '';
  return `${INTAKE_MARKER}
## Intake (issue pipeline)

${hintBlock}Round **0** — analysis handoff for peer review on issue #${issueNumber}.

Assigning **In Analysis** to \`pawpet-bot\` for peer review.`;
}

async function applyIntakeHandoff({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  hints,
  dryRun,
}) {
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const sha = bodySha(issue.body);
  const state = {
    ...defaultState(),
    round: 0,
    body_sha: sha,
    last_assignee: 'pawpet-claude',
  };

  if (dryRun) {
    return { dryRun: true, issueNumber, state };
  }

  const commentBody = buildIntakeComment(issueNumber, hints);

  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: INTAKE_MARKER,
    body: commentBody,
    token,
  });

  await upsertPipelineState({
    owner,
    repo,
    issueNumber,
    token,
    state,
    summaryLine: 'Intake handoff (round 0)',
  });

  const botTok = assignToken || token;
  await assignIssue(owner, repo, issueNumber, 'pawpet-bot', botTok);

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

  return { issueNumber, state, assigned: 'pawpet-bot', status: 'In Analysis' };
}

async function runTodoLanePipeline({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  dryRun,
}) {
  const { applyTodoLaneTriage } = require('./issue_pipeline_triage');
  const triage = await applyTodoLaneTriage({
    owner,
    repo,
    issueNumber,
    token,
    projectsPat,
    projectId,
    statusFieldId,
    dryRun,
  });
  if (triage.next !== 'intake') {
    return { phase: 'triage', triage };
  }
  const intake = await applyIntakeHandoff({
    owner,
    repo,
    issueNumber,
    token,
    projectsPat,
    projectId,
    statusFieldId,
    assignToken,
    hints: triage.hints,
    dryRun,
  });
  return { phase: 'intake', triage, intake };
}

module.exports = {
  INTAKE_MARKER,
  PIPELINE_STATE_MARKER,
  buildIntakeComment,
  applyIntakeHandoff,
  runTodoLanePipeline,
};