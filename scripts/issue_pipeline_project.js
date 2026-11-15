'use strict';

const {
  listProjectIssues,
  fetchProjectV2Item,
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

function mapPipelineIssueRow(row, full) {
  return {
    number: full.number,
    title: full.title,
    body: full.body || '',
    url: full.url,
    labels: (full.labels?.nodes || []).map((node) => node.name),
    status: normalizeStatusName(row.status),
    assignees: (full.assignees?.nodes || []).map((node) => node.login),
  };
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
    issues.push(mapPipelineIssueRow(row, full));
  }
  return issues;
}

/**
 * Resolve one issue on Pawpet without scanning the full project item list (#2302).
 */
async function fetchPipelineIssueForProject(
  owner,
  repo,
  token,
  config,
  issueNumber,
  deps = {},
) {
  const readIssue = deps.fetchIssue || fetchIssue;
  const readProjectItem = deps.fetchProjectV2Item || fetchProjectV2Item;
  // GITHUB_TOKEN cannot read org Projects v2, so projectItems comes back empty with it.
  const full = await readIssue(owner, repo, issueNumber, config.projectsPat || token);
  const projectItems = full.projectItems?.nodes || [];
  const onProject = projectItems.find((item) => item.project?.id === config.projectId);
  if (!onProject?.id) {
    return null;
  }
  const row = await readProjectItem({
    itemId: onProject.id,
    statusFieldId: config.statusFieldId,
    projectsPat: config.projectsPat,
  });
  if (!row?.issue || row.issue.state !== 'OPEN') {
    return null;
  }
  return mapPipelineIssueRow(row, full);
}

module.exports = {
  PIPELINE_STATUSES,
  normalizeStatusName,
  loadProjectSecrets,
  assertPipelineStatusOptions,
  listPipelineIssues,
  fetchPipelineIssueForProject,
  mapPipelineIssueRow,
};