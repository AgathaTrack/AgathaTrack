'use strict';

/**
 * One classification of a required check, shared by `watch-ci` and the state machine.
 *
 * Only a completed `success` is success. `skipped` and `neutral` are failures when the
 * check is required: the check did not report success. An empty conclusion, or a check
 * that has not completed, is pending — not a pass.
 *
 * Documented in docs/agent-efficiency/execute-plan-runtime.md.
 */

const REQUIRED_CHECK_FAILURES = new Set([
  'failure',
  'cancelled',
  'skipped',
  'neutral',
  'timed_out',
  'action_required',
  'stale',
]);

/**
 * @param {{ status?: string|null, conclusion?: string|null }} check
 * @returns {'success'|'failure'|'pending'}
 */
function classifyRequiredCheck(check = {}) {
  const status = check.status;
  const conclusion = check.conclusion == null ? '' : String(check.conclusion);
  if (status != null && status !== 'completed') return 'pending';
  if (status === 'completed' && conclusion === 'success') return 'success';
  if (conclusion === 'success') return 'pending';
  if (conclusion === '') return 'pending';
  if (REQUIRED_CHECK_FAILURES.has(conclusion)) return 'failure';
  if (status === 'completed') return 'failure';
  return 'pending';
}

/**
 * @param {Array<{ name?: string, status?: string|null, conclusion?: string|null }>} checks
 * @returns {{ decision: 'success'|'failure'|'pending', failing: string[] }}
 */
function classifyRequiredChecks(checks) {
  const failing = [];
  let pending = false;
  for (const check of checks || []) {
    const decision = classifyRequiredCheck(check);
    if (decision === 'failure') failing.push(check.name);
    else if (decision === 'pending') pending = true;
  }
  if (failing.length) return { decision: 'failure', failing };
  if (pending) return { decision: 'pending', failing: [] };
  return { decision: 'success', failing: [] };
}

/**
 * True when a stored check-run conclusion counts as a failed attempt.
 * Same rule as a completed check in `classifyRequiredCheck`: any conclusion other
 * than `success` is a failure. Empty means the run has not reported a verdict.
 */
function isRequiredCheckFailure(conclusion) {
  if (conclusion == null || conclusion === '' || conclusion === 'success') return false;
  return true;
}

module.exports = {
  REQUIRED_CHECK_FAILURES,
  classifyRequiredCheck,
  classifyRequiredChecks,
  isRequiredCheckFailure,
};
