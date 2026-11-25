'use strict';

/**
 * Scoped pipeline ticks (#2385). A `mission` narrows which stage rows `decide()` may apply on
 * agent-woken runs, so `/analyse-issue` cannot launch delivery while the issue is Ready.
 * Scheduled board ticks omit mission (equivalent to `board`).
 */

const MISSIONS = {
  board: {
    description: 'Full pipeline (default for cron and whole-board dispatch).',
    requiresIssue: false,
  },
  analyse: {
    description: 'To do through convergence to Ready only; never `ready.launch`.',
    requiresIssue: true,
  },
};

const ANALYSE_ALLOWED_STAGES = new Set(['Backlog', 'To do', 'In analysis']);
const POST_DELIVERY_STAGES = new Set(['In progress', 'In Main', 'In UAT', 'Done']);

/**
 * @param {{ mission?: string|null, issueNumber?: number|null }} input
 * @returns {{ ok: true, mission: string } | { ok: false, reason: string }}
 */
function resolveMission({ mission, issueNumber }) {
  const raw = mission === undefined || mission === null ? 'board' : String(mission).trim();
  const key = raw === '' ? 'board' : raw.toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MISSIONS, key)) {
    const allowed = Object.keys(MISSIONS).join(', ');
    return { ok: false, reason: `mission must be one of: ${allowed}, got "${raw}"` };
  }
  if (MISSIONS[key].requiresIssue && !(Number.isInteger(issueNumber) && issueNumber > 0)) {
    return { ok: false, reason: `mission "${key}" requires a positive issue_number` };
  }
  return { ok: true, mission: key };
}

/**
 * Mission guard inside `decideStage` before stage-specific rows.
 * @param {string} stage canonical stage from `canonicalStage`
 * @param {string|undefined} mission
 * @returns {{ type: 'none', reason: string, row: string }|null}
 */
function missionGuard(stage, mission) {
  if (!mission || mission === 'board') {
    return null;
  }
  if (mission === 'analyse') {
    if (POST_DELIVERY_STAGES.has(stage)) {
      return { type: 'none', reason: 'mission-analyse-post-ready', row: 'mission.analyse.post-ready' };
    }
    if (stage === 'Ready') {
      return { type: 'none', reason: 'mission-analyse-complete', row: 'mission.analyse.complete' };
    }
    if (!ANALYSE_ALLOWED_STAGES.has(stage)) {
      return { type: 'none', reason: 'mission-analyse-out-of-scope', row: 'mission.analyse.out-of-scope' };
    }
  }
  return null;
}

module.exports = { MISSIONS, resolveMission, missionGuard };