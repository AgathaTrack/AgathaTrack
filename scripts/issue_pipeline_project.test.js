'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPipelineIssueForProject } = require('./issue_pipeline_project');

const config = {
  projectsPat: 'pat',
  projectId: 'PVT_proj',
  statusFieldId: 'SF_status',
};

test('fetchPipelineIssueForProject returns null when issue is not on Pawpet', async () => {
  const row = await fetchPipelineIssueForProject(
    'AgathaTrack',
    'AgathaTrack',
    'token',
    config,
    2337,
    {
      fetchIssue: async () => ({
        number: 2337,
        title: 'Soak',
        body: 'body',
        url: 'https://example.invalid/2337',
        labels: { nodes: [{ name: 'pipeline-beta' }] },
        assignees: { nodes: [{ login: 'pawpet-claude' }] },
        projectItems: { nodes: [{ id: 'PVTI_x', project: { id: 'PVT_other' } }] },
      }),
    },
  );
  assert.equal(row, null);
});

test('fetchPipelineIssueForProject maps Pawpet status for scoped dispatcher ticks', async () => {
  const row = await fetchPipelineIssueForProject(
    'AgathaTrack',
    'AgathaTrack',
    'token',
    config,
    2337,
    {
      fetchIssue: async () => ({
        number: 2337,
        title: 'Soak',
        body: 'body',
        url: 'https://example.invalid/2337',
        labels: { nodes: [{ name: 'pipeline-beta' }, { name: 'bug' }] },
        assignees: { nodes: [{ login: 'pawpet-claude' }] },
        projectItems: {
          nodes: [{ id: 'PVTI_item', project: { id: config.projectId } }],
        },
      }),
      fetchProjectV2Item: async () => ({
        projectItemId: 'PVTI_item',
        status: 'To do',
        issue: { number: 2337, state: 'OPEN' },
      }),
    },
  );
  assert.equal(row.number, 2337);
  assert.equal(row.status, 'To do');
  assert.deepEqual(row.labels, ['pipeline-beta', 'bug']);
  assert.deepEqual(row.assignees, ['pawpet-claude']);
});

test('fetchPipelineIssueForProject reads projectItems with the projects PAT', async () => {
  let usedToken;
  await fetchPipelineIssueForProject('AgathaTrack', 'AgathaTrack', 'actions-token', config, 2337, {
    fetchIssue: async (_o, _r, _n, tokenArg) => {
      usedToken = tokenArg;
      return { number: 2337, projectItems: { nodes: [] } };
    },
  });
  assert.equal(usedToken, config.projectsPat);
});

test('fetchPipelineIssueForProject ignores closed project items', async () => {
  const row = await fetchPipelineIssueForProject(
    'AgathaTrack',
    'AgathaTrack',
    'token',
    config,
    99,
    {
      fetchIssue: async () => ({
        number: 99,
        title: 'Closed',
        body: '',
        url: 'u',
        labels: { nodes: [] },
        assignees: { nodes: [] },
        projectItems: {
          nodes: [{ id: 'PVTI_item', project: { id: config.projectId } }],
        },
      }),
      fetchProjectV2Item: async () => ({
        status: 'Done',
        issue: { number: 99, state: 'CLOSED' },
      }),
    },
  );
  assert.equal(row, null);
});