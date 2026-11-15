'use strict';

const { evaluateIssue } = require('../.github/scripts/triage-lib');
const {
  updateProjectStatus,
  setLabels,
  upsertMarkerComment,
  assignIssue,
  fetchIssue,
  rest,
} = require('../.github/scripts/github-project-lib');

const TRIAGE_MARKER = '<!-- pipeline-todo-triage -->';

/**
 * To-do lane triage (D-006): form checks only; risky scope is hints for delivery, not `manual-only`.
 */
function evaluateTodoLaneTriage(issue) {
  const result = evaluateIssue({
    title: issue.title,
    body: issue.body || '',
    labels: issue.labels || [],
  });

  const hints = [...(result.risks || [])];
  if (result.decision === 'manual-only' && result.missing.length === 0 && result.reasons.length === 0) {
    return {
      decision: 'pass',
      missing: [],
      risks: hints,
      reasons: [],
      hints,
    };
  }

  if (result.decision === 'manual-only') {
    return {
      decision: 'question',
      missing: result.missing,
      risks: hints,
      reasons: result.reasons,
      hints,
    };
  }

  return { ...result, hints };
}

function buildTodoTriageComment(result) {
  if (result.decision === 'pass') {
    const hintBlock =
      result.hints?.length > 0
        ? `\n\n**Delivery path hints (non-blocking):**\n${result.hints.map((h) => `- ${h}`).join('\n')}`
        : '';
    return `${TRIAGE_MARKER}
## To-do triage: passed

Deterministic form checks passed. Intake may proceed.${hintBlock}`;
  }

  const missingList = (result.missing || []).map((m) => `- ${m}`).join('\n') || '- (see reasons)';
  const reasonList =
    result.reasons?.length > 0
      ? `\n\n**Other problems:**\n${result.reasons.map((r) => `- ${r}`).join('\n')}`
      : '';

  return `${TRIAGE_MARKER}
## To-do triage: more information needed

Update the issue body with the missing fields, then move back to **To do** and assign \`pawpet-claude\`.

**Missing or insufficient fields:**
${missingList}
${reasonList}`;
}

async function applyTodoLaneTriage({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  dryRun,
}) {
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const labels = issue.labels.nodes.map((node) => node.name);
  const restIssue = await rest(
    'GET',
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
    token,
  );
  const author = restIssue?.user?.login || null;

  const result = evaluateTodoLaneTriage({
    title: issue.title,
    body: issue.body || '',
    labels,
  });

  const payload = { issueNumber, decision: result.decision, hints: result.hints || [] };
  if (dryRun) {
    return { dryRun: true, ...payload, result };
  }

  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: TRIAGE_MARKER,
    body: buildTodoTriageComment(result),
    token,
  });

  if (result.decision === 'pass') {
    if (projectsPat && projectId && statusFieldId) {
      const refreshed = await fetchIssue(owner, repo, issueNumber, token);
      await updateProjectStatus({
        issue: refreshed,
        projectId,
        statusFieldId,
        statusName: 'To do',
        projectsPat,
      });
    }
    return { ...payload, next: 'intake' };
  }

  await setLabels(owner, repo, issueNumber, ['question'], [], token);
  if (author) {
    await assignIssue(owner, repo, issueNumber, author, token);
  }
  if (projectsPat && projectId && statusFieldId) {
    const refreshed = await fetchIssue(owner, repo, issueNumber, token);
    await updateProjectStatus({
      issue: refreshed,
      projectId,
      statusFieldId,
      statusName: 'Backlog',
      projectsPat,
    });
  }
  return { ...payload, next: 'backlog' };
}

module.exports = {
  TRIAGE_MARKER,
  evaluateTodoLaneTriage,
  buildTodoTriageComment,
  applyTodoLaneTriage,
};