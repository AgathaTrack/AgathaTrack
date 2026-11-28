'use strict';

/**
 * Manual dispatch rules for issue-pipeline-v2 (#2553 P4).
 *
 * - The issue filter (`ISSUE_NUMBER`) is empty for the whole board, or one positive integer.
 *   Anything else is refused before the board is read, so invalid input cannot widen into a
 *   whole-board run.
 * - A manual dispatch previews (dry-run) unless it asks for live writes with the `live` input and
 *   the repo switch is `on`. Scheduled ticks keep the repo switch as it is.
 * - Mission scope (`PIPELINE_V2_MISSION`) is validated in `issue_pipeline_mission.js`; see analyse-issue skill.
 */

const { resolvePipelineMode } = require('./issue_pipeline_v2_mode');
const { resolveMission } = require('./issue_pipeline_mission');

const POSITIVE_INTEGER = /^[1-9]\d*$/;

/**
 * @param {string|undefined|null} raw
 * @returns {{ok: true, only: number|null} | {ok: false, reason: string}}
 */
function resolveDispatchTarget(raw) {
  if (raw === undefined || raw === null) {
    return { ok: true, only: null };
  }
  const text = String(raw).trim();
  if (text === '') {
    return { ok: true, only: null };
  }
  if (!POSITIVE_INTEGER.test(text)) {
    return { ok: false, reason: `issue_number must be a positive integer, got "${text}"` };
  }
  const only = Number(text);
  // Digits beyond 2^53 round to a different integer, which could target the wrong issue.
  if (!Number.isSafeInteger(only)) {
    return { ok: false, reason: `issue_number must be a positive integer, got "${text}"` };
  }
  return { ok: true, only };
}

/**
 * @param {{eventName?: string, liveRequested?: boolean, repoMode?: string}} input
 * @returns {{mode: 'off'|'dry-run'|'on', source: string}}
 */
function resolveRunMode({ eventName, liveRequested = false, repoMode }) {
  const requested = resolvePipelineMode(repoMode);
  if (eventName !== 'workflow_dispatch') {
    return { mode: requested, source: 'repo-variable' };
  }
  if (requested === 'off') {
    return { mode: 'off', source: 'dispatch-repo-off' };
  }
  if (!liveRequested) {
    return { mode: 'dry-run', source: 'dispatch-preview' };
  }
  if (requested === 'on') {
    return { mode: 'on', source: 'dispatch-live' };
  }
  return { mode: 'dry-run', source: 'dispatch-live-downgraded' };
}

/**
 * Validates dispatch target and mission before any board read (#2631 / analyse-issue).
 * @returns {{ ok: true, only: number|null, mission: string } | { ok: false, reason: string }}
 */
function validatePipelineDispatch({ issueNumberRaw, missionRaw }) {
  const target = resolveDispatchTarget(issueNumberRaw);
  if (!target.ok) {
    return target;
  }
  const mission = resolveMission({ mission: missionRaw, issueNumber: target.only });
  if (!mission.ok) {
    return mission;
  }
  return { ok: true, only: target.only, mission: mission.mission };
}

module.exports = { resolveDispatchTarget, resolveRunMode, validatePipelineDispatch };
