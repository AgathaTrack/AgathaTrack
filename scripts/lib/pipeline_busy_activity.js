'use strict';

const { findTrustedRunMarker, isActiveRunMarker } = require('./pipeline_run_marker');
const { listLaunchRecords } = require('../issue_pipeline_v2_launch');
const { deliveryMethod } = require('../issue_pipeline_v2_launch');
const { loadConfig } = require('../issue_pipeline_v2_config');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function commentAtMs(comment) {
  return Date.parse(comment?.updated_at || comment?.created_at);
}

function isFresh(atMs, now, windowMs) {
  return Number.isFinite(atMs) && now - atMs < windowMs;
}

/**
 * True when pipeline comment markers show live agent or engine work (fresh per stalledInactivityHours).
 * @param {{ comments: object[], now: number, limits: object, engineLogins: string[], issueIsBusy: boolean }} opts
 */
function hasLivePipelineActivity({ comments, now, limits, engineLogins, issueIsBusy }) {
  const freshnessMs = limits.stalledInactivityHours * HOUR;
  const ackWindowMs = limits.ackWindowMin * MIN;

  const trusted = findTrustedRunMarker(comments);
  if (trusted && isActiveRunMarker(trusted.marker)) {
    if (isFresh(commentAtMs(trusted.comment), now, freshnessMs)) {
      return true;
    }
  }

  const records = listLaunchRecords({ comments, engineLogins }).filter(
    (record) => record.purpose === 'delivery' || record.purpose === 'doorbell',
  );
  const latest = records.at(-1);
  if (!latest) {
    return false;
  }

  if (latest.kind === 'launch-pending') {
    return isFresh(latest.at, now, freshnessMs);
  }

  if (latest.kind === 'launch-failed') {
    return false;
  }

  if (latest.kind === 'launch-acked') {
    if (!issueIsBusy) {
      return false;
    }
    if (now - latest.at < ackWindowMs) {
      return true;
    }
    if (
      trusted &&
      isActiveRunMarker(trusted.marker) &&
      isFresh(commentAtMs(trusted.comment), now, freshnessMs)
    ) {
      return true;
    }
    return false;
  }

  if (latest.kind === 'launch') {
    if (!issueIsBusy) {
      return false;
    }
    return isFresh(latest.at, now, freshnessMs);
  }

  return false;
}

/**
 * Config limit for a delivery method when `limits.stalledInactivityHoursByMethod` is present.
 */
function resolveStalledInactivityHours(config, method) {
  const map = config.limits.stalledInactivityHoursByMethod;
  if (map && Number.isFinite(map[method])) {
    return map[method];
  }
  return config.limits.stalledInactivityHours;
}

/**
 * Idle threshold (hours) for one issue: operator override, else method-aware config limit.
 */
function idleThresholdHoursForIssue({ body, config, overrideHours }) {
  if (Number.isFinite(overrideHours) && overrideHours > 0) {
    return overrideHours;
  }
  const method = deliveryMethod(body);
  return resolveStalledInactivityHours(config, method);
}

function loadWatchdogLimits(configPath) {
  const config = loadConfig(configPath);
  return {
    limits: config.limits,
    engineLogins: config.engine?.logins || [],
  };
}

module.exports = {
  HOUR,
  MIN,
  hasLivePipelineActivity,
  idleThresholdHoursForIssue,
  resolveStalledInactivityHours,
  loadWatchdogLimits,
  commentAtMs,
  isFresh,
};