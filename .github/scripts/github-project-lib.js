'use strict';

async function graphql(token, query, variables = {}) {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();
  if (!response.ok || payload.errors) {
    throw new Error(
      `GraphQL request failed: ${JSON.stringify(payload.errors || payload, null, 2)}`,
    );
  }
  return payload.data;
}

async function rest(method, path, token, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub REST ${method} ${path} failed (${response.status}): ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function fetchIssue(owner, repo, issueNumber, token) {
  const data = await graphql(
    token,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          id
          number
          title
          body
          url
          labels(first: 50) { nodes { name } }
          assignees(first: 10) { nodes { login } }
          projectItems(first: 20) {
            nodes {
              id
              project { id }
            }
          }
        }
      }
    }`,
    { owner, repo, number: Number(issueNumber) },
  );

  const issue = data.repository?.issue;
  if (!issue) {
    throw new Error(`Issue #${issueNumber} not found in ${owner}/${repo}`);
  }
  return issue;
}

async function getStatusOptionId(projectsPat, statusFieldId, statusName) {
  const data = await graphql(
    projectsPat,
    `query($fieldId: ID!) {
      node(id: $fieldId) {
        ... on ProjectV2SingleSelectField {
          options { id name }
        }
      }
    }`,
    { fieldId: statusFieldId },
  );

  const options = data.node?.options || [];
  const match = options.find(
    (option) => option.name.toLowerCase() === statusName.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `Status option "${statusName}" not found on field ${statusFieldId}. Available: ${options
        .map((o) => o.name)
        .join(', ')}`,
    );
  }
  return match.id;
}

function getIssueProjectStatus(item, statusFieldId) {
  for (const fieldValue of item.fieldValues?.nodes || []) {
    if (fieldValue.field?.id === statusFieldId) {
      return fieldValue.name;
    }
  }
  return null;
}

function getProjectItemTextField(item, textFieldId) {
  for (const fieldValue of item.fieldValues?.nodes || []) {
    if (fieldValue.field?.id === textFieldId && typeof fieldValue.text === 'string') {
      return fieldValue.text;
    }
  }
  return '';
}

async function updateProjectItemTextField({
  projectId,
  itemId,
  fieldId,
  text,
  projectsPat,
}) {
  await graphql(
    projectsPat,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { text: $text }
        }
      ) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId, fieldId, text: text ?? '' },
  );
}

async function assertProjectTextField(projectsPat, fieldId, expectedName) {
  const data = await graphql(
    projectsPat,
    `query($fieldId: ID!) {
      node(id: $fieldId) {
        ... on ProjectV2Field {
          id
          name
          dataType
        }
      }
    }`,
    { fieldId },
  );
  const field = data.node;
  if (!field?.id) {
    throw new Error(`Project text field ${fieldId} not found`);
  }
  if (field.dataType !== 'TEXT') {
    throw new Error(`Project field "${field.name}" is not TEXT (got ${field.dataType})`);
  }
  if (expectedName && field.name?.toLowerCase() !== expectedName.toLowerCase()) {
    throw new Error(
      `Project field name mismatch: expected "${expectedName}", got "${field.name}"`,
    );
  }
  return field;
}

async function ensureProjectItem(issue, projectId, projectsPat) {
  const existing = issue.projectItems.nodes.find((item) => item.project.id === projectId);
  if (existing) return existing.id;

  const data = await graphql(
    projectsPat,
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
        item { id }
      }
    }`,
    { projectId, contentId: issue.id },
  );

  return data.addProjectV2ItemById.item.id;
}

async function updateProjectStatus({
  issue,
  projectId,
  statusFieldId,
  statusName,
  projectsPat,
}) {
  const itemId = await ensureProjectItem(issue, projectId, projectsPat);
  const optionId = await getStatusOptionId(projectsPat, statusFieldId, statusName);

  await graphql(
    projectsPat,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(
        input: {
          projectId: $projectId
          itemId: $itemId
          fieldId: $fieldId
          value: { singleSelectOptionId: $optionId }
        }
      ) {
        projectV2Item { id }
      }
    }`,
    {
      projectId,
      itemId,
      fieldId: statusFieldId,
      optionId,
    },
  );
}

const PROJECT_ITEMS_PAGE_SIZE = 100;

async function fetchProjectV2Item({ itemId, statusFieldId, projectsPat }) {
  const data = await graphql(
    projectsPat,
    `query($itemId: ID!) {
      node(id: $itemId) {
        ... on ProjectV2Item {
          id
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { id name } }
              }
            }
          }
          content {
            ... on Issue {
              id
              number
              title
              body
              url
              state
              labels(first: 30) { nodes { name } }
            }
          }
        }
      }
    }`,
    { itemId },
  );

  const item = data.node;
  if (!item?.content) {
    return null;
  }
  return {
    projectItemId: item.id,
    status: getIssueProjectStatus(item, statusFieldId),
    issue: item.content,
  };
}

const PROJECT_ITEM_FIELD_VALUES_FRAGMENT = `
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2SingleSelectField { id name } }
      }
      ... on ProjectV2ItemFieldTextValue {
        text
        field { ... on ProjectV2Field { id name } }
      }
    }
  }
`;

async function listProjectIssues({
  projectId,
  statusFieldId,
  projectsPat,
  syncedFieldId = null,
}) {
  const items = [];
  let after = null;
  while (true) {
    const data = await graphql(
      projectsPat,
      `query($projectId: ID!, $after: String) {
        node(id: $projectId) {
          ... on ProjectV2 {
            items(first: ${PROJECT_ITEMS_PAGE_SIZE}, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                ${PROJECT_ITEM_FIELD_VALUES_FRAGMENT}
                content {
                  ... on Issue {
                    id
                    number
                    title
                    body
                    url
                    state
                    repository { name owner { login } }
                    labels(first: 30) { nodes { name } }
                  }
                }
              }
            }
          }
        }
      }`,
      { projectId, after },
    );

    const page = data.node?.items;
    const nodes = page?.nodes || [];
    items.push(...nodes);
    if (!page?.pageInfo?.hasNextPage) {
      break;
    }
    after = page.pageInfo.endCursor;
  }

  return items
    .map((item) => {
      const issue = item.content;
      if (!issue || issue.state !== 'OPEN') return null;
      const row = {
        projectItemId: item.id,
        status: getIssueProjectStatus(item, statusFieldId),
        issue,
      };
      if (syncedFieldId) {
        row.syncedStage = getProjectItemTextField(item, syncedFieldId);
      }
      return row;
    })
    .filter(Boolean);
}

async function searchEligibleIssues(owner, repo, token) {
  const q = encodeURIComponent(
    `repo:${owner}/${repo} is:issue is:open label:agent-approved label:human-reviewed -label:busy -label:manual-only -label:blocked`,
  );
  const data = await rest('GET', `/search/issues?q=${q}&per_page=20`, token);
  return data.items || [];
}

async function fetchAllIssueComments(owner, repo, issueNumber, token) {
  const comments = [];
  let page = 1;
  while (true) {
    const batch = await rest(
      'GET',
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    if (!batch.length) {
      break;
    }
    comments.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }
  return comments;
}

async function upsertMarkerComment({
  owner,
  repo,
  issueNumber,
  marker,
  body,
  token,
  match,
}) {
  const comments = await fetchAllIssueComments(owner, repo, issueNumber, token);
  const existing = comments.find(
    (comment) => comment.body?.includes(marker) && (!match || match(comment)),
  );

  if (existing) {
    await rest(
      'PATCH',
      `/repos/${owner}/${repo}/issues/comments/${existing.id}`,
      token,
      { body },
    );
    return existing.id;
  }

  const created = await rest(
    'POST',
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    token,
    { body },
  );
  return created.id;
}

async function setLabels(owner, repo, issueNumber, add, remove, token) {
  for (const label of remove) {
    await rest(
      'DELETE',
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      token,
    ).catch(() => {});
  }

  if (add.length > 0) {
    await rest('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, token, {
      labels: add,
    });
  }
}

/**
 * Replace the issue assignee list (empty array clears all assignees).
 */
async function setIssueAssignees(owner, repo, issueNumber, assignees, token) {
  // The assignees sub-resource only supports POST (add) and DELETE (remove);
  // PATCH on the issue replaces the whole list (#2363 review).
  await rest('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`, token, {
    assignees: assignees || [],
  });
}

async function assignIssue(owner, repo, issueNumber, assignee, token) {
  await setIssueAssignees(owner, repo, issueNumber, [assignee], token);
}

function parseRepo(repository) {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }
  return { owner, repo };
}

function hasLabel(issue, labelName) {
  const labels = issue.labels?.nodes || issue.labels || [];
  return labels.some((label) => {
    const name = typeof label === 'string' ? label : label.name;
    return name.toLowerCase() === labelName.toLowerCase();
  });
}

async function reopenIssue(owner, repo, issueNumber, token) {
  await rest('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`, token, {
    state: 'open',
  });
}

async function closeIssue(owner, repo, issueNumber, token) {
  await rest('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`, token, {
    state: 'closed',
  });
}

async function triggerWorkflowDispatch({
  owner,
  repo,
  workflowFile,
  workflowRef,
  token,
  inputs = {},
}) {
  await rest(
    'POST',
    `/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`,
    token,
    {
      ref: workflowRef,
      inputs,
    },
  );
}

module.exports = {
  graphql,
  rest,
  fetchIssue,
  getStatusOptionId,
  ensureProjectItem,
  updateProjectStatus,
  fetchProjectV2Item,
  listProjectIssues,
  PROJECT_ITEMS_PAGE_SIZE,
  searchEligibleIssues,
  fetchAllIssueComments,
  upsertMarkerComment,
  setLabels,
  assignIssue,
  setIssueAssignees,
  reopenIssue,
  closeIssue,
  triggerWorkflowDispatch,
  parseRepo,
  hasLabel,
  getIssueProjectStatus,
  getProjectItemTextField,
  updateProjectItemTextField,
  assertProjectTextField,
};
