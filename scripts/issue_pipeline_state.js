'use strict';

const { bodySha, normalizeBodyForHash } = require('./issue_pipeline_v2_hash');

const STATE_MARKER = '<!-- agent-state:';
const PIPELINE_STATE_MARKER = '<!-- pipeline-state -->';
const DELIVERY_LABELS = new Set(['PR', 'light-plan', 'execute-plan']);
const DEFAULT_ROUND_CAP = 6;

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

function hasDeliveryLabel(labels) {
  const names = (labels || []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  return names.some((name) => DELIVERY_LABELS.has(name));
}

function deliveryLabel(labels) {
  const names = (labels || []).map((label) =>
    typeof label === 'string' ? label : label.name,
  );
  return names.find((name) => DELIVERY_LABELS.has(name)) || null;
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

function buildStateMarkerBody(state, summaryLine) {
  const line = summaryLine ? `${summaryLine}\n\n` : '';
  return `${PIPELINE_STATE_MARKER}\n${line}<!-- agent-state: ${JSON.stringify(state)} -->`;
}

module.exports = {
  STATE_MARKER,
  PIPELINE_STATE_MARKER,
  buildStateMarkerBody,
  DELIVERY_LABELS,
  DEFAULT_ROUND_CAP,
  normalizeBodyForHash,
  bodySha,
  parseStateMarker,
  findLatestStateComment,
  hasDeliveryLabel,
  deliveryLabel,
  defaultState,
};