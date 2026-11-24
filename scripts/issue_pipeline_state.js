'use strict';

const { bodySha, normalizeBodyForHash } = require('./issue_pipeline_v2_hash');

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

function findLatestStateComment(comments) {
  let latest = null;
  for (const comment of comments || []) {
    const state = parseStateMarker(comment.body || '');
    if (!state) {
      continue;
    }
    const updatedAt =
      comment.updated_at || comment.updatedAt || comment.created_at || comment.createdAt || '';
    if (!latest || updatedAt >= latest.updatedAt) {
      latest = { state, commentId: comment.id, updatedAt };
    }
  }
  return latest;
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

module.exports = {
  STATE_MARKER,
  PIPELINE_STATE_MARKER,
  normalizeBodyForHash,
  bodySha,
  parseStateMarker,
  findLatestStateComment,
  defaultState,
};