'use strict';

const crypto = require('crypto');

const STATE_MARKER = '<!-- agent-state:';
const DELIVERY_LABELS = new Set(['PR', 'light-plan', 'execute-plan']);
const DEFAULT_ROUND_CAP = 6;

function normalizeBodyForHash(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.replace(/[ \t]+$/gm, '').trimEnd();
}

function bodySha(body) {
  const normalized = normalizeBodyForHash(body);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

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
    const createdAt = comment.created_at || comment.createdAt || '';
    if (!latest || createdAt >= latest.createdAt) {
      latest = { state, commentId: comment.id, createdAt };
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

module.exports = {
  STATE_MARKER,
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