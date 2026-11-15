'use strict';

const { fetchAllIssueComments } = require('../.github/scripts/github-project-lib');
const { findLatestStateComment, defaultState } = require('./issue_pipeline_state');

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

module.exports = {
  loadIssueState,
};