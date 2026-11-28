'use strict';

/**
 * Trusted pipeline-state comments for the execute-plan approve path (run D, T1).
 * Moved verbatim from `scripts/issue_pipeline_state.js` and `scripts/lib/pipeline_state_trust.js`.
 * This module must not require `issue_pipeline_state.js`: the old module is deleted in T3.
 *
 * Fail-closed: when no trusted comment exists, the approve path returns `no-pipeline-state`
 * (see `execute_plan_pipeline_approve.js`).
 */

const STATE_MARKER = '<!-- agent-state:';
const PIPELINE_STATE_MARKER = '<!-- pipeline-state -->';

function parseStateMarker(text) {
  const haystack = String(text);
  const idx = haystack.indexOf(STATE_MARKER);
  if (idx === -1) {
    return null;
  }
  const start = idx + STATE_MARKER.length;
  const end = haystack.indexOf('-->', start);
  if (end === -1) {
    return null;
  }
  try {
    return JSON.parse(haystack.slice(start, end).trim());
  } catch {
    return null;
  }
}

function defaultState() {
  return {
    round: 0,
    stuck: 0,
    last_assignee: null,
    body_sha: null,
    delivery: null,
    owner_reason: null,
    run_id: null,
    verdicts: {},
    converged_at: null,
  };
}

const TRUSTED_PIPELINE_STATE_AUTHORS = new Set(['pawpet-bot', 'pawpet-claude']);

function commentAuthorLogin(comment) {
  return comment?.user?.login || comment?.author?.login || null;
}

function commentEditorLogin(comment) {
  if (comment?.editor_login) {
    return comment.editor_login;
  }
  if (comment?.last_edited_by?.login) {
    return comment.last_edited_by.login;
  }
  return null;
}

/**
 * @returns {{ trusted: boolean, reason?: string }}
 */
function assessPipelineStateCommentTrust(comment) {
  const author = commentAuthorLogin(comment);
  if (!author || !TRUSTED_PIPELINE_STATE_AUTHORS.has(author)) {
    return { trusted: false, reason: 'untrusted-author' };
  }
  const body = String(comment?.body || '');
  if (!body.includes(PIPELINE_STATE_MARKER)) {
    return { trusted: false, reason: 'missing-pipeline-state-marker' };
  }
  if (!parseStateMarker(body)) {
    return { trusted: false, reason: 'invalid-state-marker' };
  }
  const editor = commentEditorLogin(comment);
  if (editor && editor !== author) {
    return { trusted: false, reason: 'editor-not-author' };
  }
  return { trusted: true };
}

function isTrustedPipelineStateComment(comment) {
  return assessPipelineStateCommentTrust(comment).trusted;
}

function findLatestTrustedStateComment(comments) {
  let latest = null;
  for (const comment of comments || []) {
    if (!isTrustedPipelineStateComment(comment)) {
      continue;
    }
    const state = parseStateMarker(comment.body || '');
    if (!state) {
      continue;
    }
    const updatedAt =
      comment.updated_at || comment.updatedAt || comment.created_at || comment.createdAt || '';
    if (!latest || updatedAt >= latest.updatedAt) {
      latest = { state, commentId: comment.id, updatedAt, author: commentAuthorLogin(comment) };
    }
  }
  return latest;
}

module.exports = {
  STATE_MARKER,
  PIPELINE_STATE_MARKER,
  parseStateMarker,
  defaultState,
  TRUSTED_PIPELINE_STATE_AUTHORS,
  commentAuthorLogin,
  assessPipelineStateCommentTrust,
  isTrustedPipelineStateComment,
  findLatestTrustedStateComment,
};
