#!/usr/bin/env node
'use strict';

const {
  parseRepo,
  fetchIssue,
  updateProjectStatus,
  setLabels,
  assignIssue,
} = require('../.github/scripts/github-project-lib');
const { resolvePipelineMode, pipelineModeWritesLive } = require('./issue_pipeline_mode');
const { isPipelineIssue } = require('./issue_pipeline_gate');

async function applyTodoShortcut({
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
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const labels = issue.labels.nodes.map((node) => node.name);
  const mode = resolvePipelineMode(process.env.ISSUE_PIPELINE);

  if (mode === 'off') {
    return {
      skipped: true,
      reason: 'ISSUE_PIPELINE off',
      issueNumber,
    };
  }

  if (!isPipelineIssue(labels, mode)) {
    return {
      skipped: true,
      reason: 'not_pipeline_beta',
      issueNumber,
    };
  }

  if (dryRun) {
    return { dryRun: true, issueNumber, action: 'todo-shortcut' };
  }

  if (projectsPat && projectId && statusFieldId) {
    await updateProjectStatus({
      issue,
      projectId,
      statusFieldId,
      statusName: 'To do',
      projectsPat,
    });
  }

  await setLabels(owner, repo, issueNumber, [], ['todo'], token);
  const botTok = assignToken || token;
  await assignIssue(owner, repo, issueNumber, 'pawpet-claude', botTok);

  return { issueNumber, status: 'To do', assignee: 'pawpet-claude' };
}

function hasLabelTodo(labels) {
  return (labels || []).includes('todo');
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const issueNumber = process.env.ISSUE_NUMBER;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !issueNumber || !token) {
    throw new Error('GITHUB_REPOSITORY, ISSUE_NUMBER, and GITHUB_TOKEN are required');
  }
  const { owner, repo } = parseRepo(repository);
  const mode = resolvePipelineMode(process.env.ISSUE_PIPELINE);
  if (mode === 'off') {
    console.log(JSON.stringify({ skipped: true, reason: 'ISSUE_PIPELINE off' }));
    process.exit(0);
  }
  const dryRun = !pipelineModeWritesLive(mode);
  const result = await applyTodoShortcut({
    owner,
    repo,
    issueNumber: Number(issueNumber),
    token,
    projectsPat: process.env.GH_PROJECTS_PAT,
    projectId: process.env.GH_PROJECT_ID,
    statusFieldId: process.env.GH_STATUS_FIELD_ID,
    assignToken: process.env.EXECUTE_PLAN_BOT_TOKEN,
    dryRun,
  });
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  applyTodoShortcut,
  hasLabelTodo,
};