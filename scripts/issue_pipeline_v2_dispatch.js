'use strict';

/**
 * Manual dispatch rules for issue-pipeline-v2 (#2553 P4).
 *
 * - The issue filter (`ISSUE_NUMBER`) is empty for the whole board, or one positive integer.
 *   Anything else is refused before the board is read, so invalid input cannot widen into a
 *   whole-board run.
 * - A manual dispatch previews (dry-run) unless it asks for live writes with the `live` input and
 *   the repo switch is `on`. Scheduled ticks keep the repo switch as it is.
 */

const { resolvePipelineMode } = require('./issue_pipeline_mode');

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

module.exports = { resolveDispatchTarget, resolveRunMode };
