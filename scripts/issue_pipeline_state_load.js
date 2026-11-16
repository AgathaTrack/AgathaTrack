'use strict';

const {
  fetchAllIssueComments,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const {
  defaultState,
  PIPELINE_STATE_MARKER,
  buildStateMarkerBody,
} = require('./issue_pipeline_state');
const { findLatestTrustedStateComment } = require('./lib/pipeline_state_trust');

async function loadIssueState(owner, repo, issueNumber, token) {
  const comments = await fetchAllIssueComments(owner, repo, issueNumber, token);
  const latest = findLatestTrustedStateComment(comments);
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
  assignToken,
  state,
  summaryLine,
}) {
  const writeToken = assignToken || token;
  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: PIPELINE_STATE_MARKER,
    body: buildStateMarkerBody(state, summaryLine),
    token: writeToken,
  });
}

module.exports = {
  loadIssueState,
  upsertPipelineState,
};