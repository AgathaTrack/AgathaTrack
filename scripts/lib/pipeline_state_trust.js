'use strict';

const {
  parseStateMarker,
  PIPELINE_STATE_MARKER,
} = require('../issue_pipeline_state');

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
  TRUSTED_PIPELINE_STATE_AUTHORS,
  assessPipelineStateCommentTrust,
  isTrustedPipelineStateComment,
  findLatestTrustedStateComment,
  commentAuthorLogin,
};