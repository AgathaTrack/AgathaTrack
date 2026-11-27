'use strict';

const { graphql } = require('../.github/scripts/github-project-lib');

/**
 * Body edit history. REST and the issue timeline record no body edits, so the editor of the last
 * body change comes from `userContentEdits` (#2385). The connection is paged backwards from the
 * newest edit, so an issue with more than one page of edits is still read in full. Oldest first.
 * @returns {Promise<{ author: string|null, edits: Array<{ editor: string|null, editedAt: string }> }>}
 */
async function fetchBodyEdits({ owner, repo, issueNumber, token, graphqlFn = graphql, maxPages = 20 }) {
  const edits = [];
  let author = null;
  let before = null;
  for (let page = 0; page < maxPages; page += 1) {
    const data = await graphqlFn(
      token,
      `query($owner: String!, $repo: String!, $number: Int!, $before: String) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            author { login }
            userContentEdits(last: 100, before: $before) {
              pageInfo { hasPreviousPage startCursor }
              nodes { editedAt editor { login } }
            }
          }
        }
      }`,
      { owner, repo, number: Number(issueNumber), before },
    );
    const issue = data?.repository?.issue;
    author = author || issue?.author?.login || null;
    const connection = issue?.userContentEdits;
    for (const node of connection?.nodes || []) {
      edits.push({ editor: node.editor?.login || null, editedAt: node.editedAt });
    }
    if (!connection?.pageInfo?.hasPreviousPage) {
      break;
    }
    before = connection.pageInfo.startCursor;
  }
  return { author, edits: edits.sort((a, b) => a.editedAt.localeCompare(b.editedAt)) };
}

/** Who last edited an issue comment (null when it was never edited). */
async function fetchCommentEditor({ nodeId, token, graphqlFn = graphql }) {
  if (!nodeId) {
    return null;
  }
  const data = await graphqlFn(
    token,
    `query($id: ID!) {
      node(id: $id) {
        ... on IssueComment { lastEditedAt editor { login } }
      }
    }`,
    { id: nodeId },
  );
  const node = data?.node;
  return node?.lastEditedAt ? node.editor?.login || null : null;
}

/** Open issues that block `issueNumber` (GitHub issue dependencies). */
async function fetchIssueBlockedBy({ owner, repo, issueNumber, token, graphqlFn = graphql }) {
  try {
    const data = await graphqlFn(
      token,
      `query($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          issue(number: $number) {
            blockedBy(first: 50) {
              nodes { number state }
            }
          }
        }
      }`,
      { owner, repo, number: Number(issueNumber) },
    );
    const nodes = data?.repository?.issue?.blockedBy?.nodes || [];
    const open = nodes.filter((node) => String(node.state || '').toUpperCase() === 'OPEN').map((node) => node.number);
    return { open, error: null };
  } catch (error) {
    return { open: null, error: String(error?.message ?? error) };
  }
}

module.exports = { fetchBodyEdits, fetchCommentEditor, fetchIssueBlockedBy };
