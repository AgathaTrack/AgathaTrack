'use strict';

const {
  listProjectIssues,
  graphql,
  fetchIssue,
} = require('../.github/scripts/github-project-lib');

const PIPELINE_STATUSES = [
  'Backlog',
  'To do',
  'In Analysis',
  'Ready',
  'In progress',
  'In Main',
  'In UAT',
  'Done',
];

function normalizeStatusName(name) {
  if (!name) {
    return null;
  }
  const key = String(name).trim().toLowerCase();
  const aliases = {
    backlog: 'Backlog',
    'to do': 'To do',
    'in analysis': 'In Analysis',
    ready: 'Ready',
    'in progress': 'In progress',
    'in main': 'In Main',
    'in uat': 'In UAT',
    done: 'Done',
  };
  return aliases[key] || String(name).trim();
}

function loadProjectSecrets() {
  const projectsPat = process.env.GH_PROJECTS_PAT;
  const projectId = process.env.GH_PROJECT_ID;
  const statusFieldId = process.env.GH_STATUS_FIELD_ID;
  if (!projectsPat || !projectId || !statusFieldId) {
    return null;
  }
  return { projectsPat, projectId, statusFieldId };
}

async function assertPipelineStatusOptions(projectsPat, statusFieldId) {
  const data = await graphql(
    projectsPat,
    `query($fieldId: ID!) {
      node(id: $fieldId) {
        ... on ProjectV2SingleSelectField {
          options { name }
        }
      }
    }`,
    { fieldId: statusFieldId },
  );
  const options = (data.node?.options || []).map((option) => option.name);
  const missing = PIPELINE_STATUSES.filter(
    (required) =>
      !options.some((option) => option.toLowerCase() === required.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new Error(
      `Pawpet Status missing pipeline options: ${missing.join(', ')}. Live options: ${options.join(', ')}`,
    );
  }
  return options;
}

async function listPipelineIssues(owner, repo, token, config) {
  const rows = await listProjectIssues({
    projectId: config.projectId,
    statusFieldId: config.statusFieldId,
    projectsPat: config.projectsPat,
  });
  const issues = [];
  for (const row of rows) {
    const full = await fetchIssue(owner, repo, row.issue.number, token);
    issues.push({
      number: full.number,
      title: full.title,
      body: full.body || '',
      url: full.url,
      labels: (full.labels?.nodes || []).map((node) => node.name),
      status: normalizeStatusName(row.status),
      assignees: (full.assignees?.nodes || []).map((node) => node.login),
    });
  }
  return issues;
}

module.exports = {
  PIPELINE_STATUSES,
  normalizeStatusName,
  loadProjectSecrets,
  assertPipelineStatusOptions,
  listPipelineIssues,
};