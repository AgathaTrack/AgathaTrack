'use strict';

const {
  graphql,
  fetchAllIssueComments,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const {
  defaultState,
  PIPELINE_STATE_MARKER,
  buildStateMarkerBody,
} = require('./issue_pipeline_state');
const {
  findLatestTrustedStateComment,
  findLatestLegacyStateComment,
  isEditorLookupCandidate,
  isTrustedStateAuthor,
} = require('./lib/pipeline_state_trust');

/**
 * Last editor of an issue comment. REST comments carry no editor, so read it from GraphQL.
 * @returns {Promise<string|null>} login, or null when the comment was never edited
 */
async function fetchCommentEditor(token, nodeId) {
  if (!nodeId) {
    return null;
  }
  const data = await graphql(
    token,
    `query($id: ID!) {
      node(id: $id) {
        ... on IssueComment { editor { login } lastEditedAt }
      }
    }`,
    { id: nodeId },
  );
  const node = data?.node;
  if (!node?.lastEditedAt) {
    return null;
  }
  return node.editor?.login || null;
}

/**
 * Latest edit of the issue body (#2363 §3.3). The timeline has no body-edit event, so this
 * reads `userContentEdits`. Returns null when the body was never edited.
 * @returns {Promise<{ editor: string|null, editedAt: string }|null>}
 */
async function fetchLatestBodyEdit(token, owner, repo, issueNumber) {
  const data = await graphql(
    token,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          userContentEdits(last: 1) { nodes { editedAt editor { login } } }
        }
      }
    }`,
    { owner, repo, number: Number(issueNumber) },
  );
  const node = data?.repository?.issue?.userContentEdits?.nodes?.[0];
  if (!node?.editedAt) {
    return null;
  }
  return { editor: node.editor?.login || null, editedAt: node.editedAt };
}

/**
 * Load pipeline state for one issue.
 *
 * Source order: the dedicated `pipeline-state` comment from a trusted author whose last editor
 * is that author; else the newest legacy lane comment from a trusted author (migration, §3.4);
 * else default state. `source` says which one was used.
 */
async function loadIssueState(owner, repo, issueNumber, token, io = {}) {
  const fetchComments = io.fetchAllIssueComments || fetchAllIssueComments;
  const fetchEditor = io.fetchCommentEditor || ((nodeId) => fetchCommentEditor(token, nodeId));
  const comments = await fetchComments(owner, repo, issueNumber, token);

  const enriched = [];
  for (const comment of comments || []) {
    if (isEditorLookupCandidate(comment) && comment.editor_login === undefined) {
      const editor = await fetchEditor(comment.node_id);
      enriched.push(editor ? { ...comment, editor_login: editor } : comment);
    } else {
      enriched.push(comment);
    }
  }

  const latest = findLatestTrustedStateComment(enriched);
  if (latest) {
    return {
      state: { ...defaultState(), ...latest.state },
      commentId: latest.commentId,
      updatedAt: latest.updatedAt,
      source: 'pipeline-state',
    };
  }

  const hasDedicated = enriched.some(isEditorLookupCandidate);
  if (!hasDedicated) {
    const legacy = findLatestLegacyStateComment(enriched);
    if (legacy) {
      return {
        state: { ...defaultState(), ...legacy.state },
        commentId: null,
        updatedAt: legacy.updatedAt,
        source: 'legacy',
      };
    }
  }

  return {
    state: defaultState(),
    commentId: null,
    updatedAt: null,
    source: hasDedicated ? 'rejected' : 'none',
  };
}

/**
 * Write state into the dedicated comment. Fails closed without the bot token: a state comment
 * written by the Actions token is untrusted and would never be read back.
 */
async function upsertPipelineState({
  owner,
  repo,
  issueNumber,
  assignToken,
  state,
  summaryLine,
  io = {},
}) {
  if (!assignToken) {
    throw new Error('EXECUTE_PLAN_BOT_TOKEN is required to write pipeline state');
  }
  const upsert = io.upsertMarkerComment || upsertMarkerComment;
  await upsert({
    owner,
    repo,
    issueNumber,
    marker: PIPELINE_STATE_MARKER,
    body: buildStateMarkerBody(state, summaryLine),
    token: assignToken,
    match: isTrustedStateAuthor,
  });
}

module.exports = {
  loadIssueState,
  upsertPipelineState,
  fetchCommentEditor,
  fetchLatestBodyEdit,
};
