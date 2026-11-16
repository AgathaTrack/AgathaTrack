'use strict';

const {
  fetchAllIssueComments,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const {
  findLatestStateComment,
  defaultState,
  PIPELINE_STATE_MARKER,
  buildStateMarkerBody,
} = require('./issue_pipeline_state');

async function loadIssueState(owner, repo, issueNumber, token) {
  const comments = await fetchAllIssueComments(owner, repo, issueNumber, token);
  const latest = findLatestStateComment(comments);
  if (!latest) {
    return { state: defaultState(), commentId: null };
  }
  return {
    state: { ...defaultState(), ...latest.state },
    commentId: latest.commentId,
  };
}

async function upsertPipelineState({
  owner,
  repo,
  issueNumber,
  token,
  state,
  summaryLine,
}) {
  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: PIPELINE_STATE_MARKER,
    body: buildStateMarkerBody(state, summaryLine),
    token,
  });
}

module.exports = {
  loadIssueState,
  upsertPipelineState,
};