'use strict';

const { findTrustedRunMarker, isActiveRunMarker } = require('./pipeline_run_marker');
const { listLaunchRecords } = require('../issue_pipeline_v2_launch');

const LIVE_PURPOSES = new Set(['delivery', 'doorbell']);
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;

function recordTimestampMs(comment) {
  const t = Date.parse(comment?.updated_at || comment?.created_at || '');
  return Number.isFinite(t) ? t : null;
}

function isFresh(atMs, now, freshnessHours) {
  if (!Number.isFinite(atMs)) {
    return false;
  }
  return now - atMs < freshnessHours * HOUR_MS;
}

function hasFreshActiveRunMarker(comments, now, freshnessHours) {
  const trusted = findTrustedRunMarker(comments);
  if (!trusted || !isActiveRunMarker(trusted.marker)) {
    return false;
  }
  const at = recordTimestampMs(trusted.comment);
  return isFresh(at, now, freshnessHours);
}

function deliveryDoorbellRecords(comments, engineLogins) {
  return listLaunchRecords({ comments, engineLogins }).filter((record) => LIVE_PURPOSES.has(record.purpose));
}

/**
 * True when pipeline comments show delivery or doorbell work still in flight within engine limits.
 * @param {{ comments: object[], engineLogins: string[], busy: boolean, now?: number, limits: { stalledInactivityHours: number, ackWindowMin: number } }} opts
 */
function hasLivePipelineActivity({ comments, engineLogins, busy, now = Date.now(), limits }) {
  const freshnessHours = limits.stalledInactivityHours;
  const ackWindowMs = limits.ackWindowMin * MIN_MS;

  if (hasFreshActiveRunMarker(comments, now, freshnessHours)) {
    return true;
  }

  const latest = deliveryDoorbellRecords(comments, engineLogins).at(-1);
  if (!latest) {
    return false;
  }

  if (latest.kind === 'launch-pending') {
    return isFresh(latest.at, now, freshnessHours);
  }

  if (latest.kind === 'launch') {
    return busy && isFresh(latest.at, now, freshnessHours);
  }

  if (latest.kind === 'launch-acked') {
    if (!busy) {
      return false;
    }
    if (now - latest.at < ackWindowMs) {
      return true;
    }
    return hasFreshActiveRunMarker(comments, now, freshnessHours);
  }

  return false;
}

module.exports = {
  hasLivePipelineActivity,
  hasFreshActiveRunMarker,
  deliveryDoorbellRecords,
};