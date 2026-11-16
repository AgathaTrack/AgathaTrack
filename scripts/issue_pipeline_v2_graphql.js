'use strict';

const { graphql } = require('../.github/scripts/github-project-lib');

/**
 * Body edit history. REST and the issue timeline record no body edits, so the editor of the last
 * body change comes from `userContentEdits` (#2385). Oldest first.
 * @returns {Promise<{ author: string|null, edits: Array<{ editor: string|null, editedAt: string }> }>}
 */
async function fetchBodyEdits({ owner, repo, issueNumber, token, graphqlFn = graphql }) {
  const data = await graphqlFn(
    token,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          author { login }
          userContentEdits(last: 50) { nodes { editedAt editor { login } } }
        }
      }
    }`,
    { owner, repo, number: Number(issueNumber) },
  );
  const issue = data?.repository?.issue;
  const nodes = issue?.userContentEdits?.nodes || [];
  return {
    author: issue?.author?.login || null,
    edits: nodes
      .map((node) => ({ editor: node.editor?.login || null, editedAt: node.editedAt }))
      .sort((a, b) => a.editedAt.localeCompare(b.editedAt)),
  };
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

module.exports = { fetchBodyEdits, fetchCommentEditor };
