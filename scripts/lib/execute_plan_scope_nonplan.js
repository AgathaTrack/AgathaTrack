'use strict';

/**
 * Non–execute-plan PR forbidden-path gate (#1980).
 * Uses agent-safety-lib paths; owner ack via execute_plan_scope_ack (same as plan phase PRs).
 */

const { findForbiddenPaths } = require('../../.github/scripts/agent-safety-lib');

const SUMMARY_MAX_LINES = 50;

function forbiddenGateMode() {
  return process.env.FORBIDDEN_GATE_MODE === 'report-only' ? 'report-only' : 'enforce';
}

/**
 * @param {{ files: string[], scopeAckReview?: object|null, mode?: 'report-only'|'enforce', prAuthor?: string|null, owners?: string[] }}
 */
function evaluateNonPlanForbidden({
  files,
  scopeAckReview = null,
  mode = forbiddenGateMode(),
  prAuthor = null,
  owners = [],
}) {
  const ownerList = owners || [];
  if (prAuthor && ownerList.includes(prAuthor)) {
    return {
      conclusion: 'success',
      title: 'ok',
      summary: 'owner-authored PR (forbidden-path gate skipped)',
      violations: [],
      ownerApprovedForbidden: [],
    };
  }

  const forbidden = findForbiddenPaths(files || []);
  const scopeAckActive = Boolean(scopeAckReview);
  const ownerApprovedForbidden = [];
  const violations = [];

  for (const file of forbidden) {
    if (scopeAckActive) ownerApprovedForbidden.push(file);
    else violations.push({ file, reason: 'forbidden' });
  }

  const summary = renderForbiddenPathSummary({ violations, ownerApprovedForbidden, scopeAckReview, wouldBlockOnly: false });

  if (violations.length === 0) {
    return {
      conclusion: 'success',
      title: 'ok',
      summary,
      violations: [],
      ownerApprovedForbidden,
      scopeAckReviewId: scopeAckReview && scopeAckReview.id,
    };
  }

  if (mode === 'report-only') {
    const advisory = renderForbiddenPathSummary({
      violations,
      ownerApprovedForbidden,
      scopeAckReview: null,
      wouldBlockOnly: true,
    });
    return {
      conclusion: 'success',
      title: 'forbidden-advisory',
      summary: advisory,
      violations,
      ownerApprovedForbidden: [],
    };
  }

  return {
    conclusion: 'failure',
    title: 'forbidden',
    summary,
    violations,
    ownerApprovedForbidden: [],
  };
}

function renderForbiddenPathSummary({
  violations,
  ownerApprovedForbidden,
  scopeAckReview,
  wouldBlockOnly,
}) {
  const lines = [];
  if (wouldBlockOnly) {
    lines.push(`Report-only: ${violations.length} path(s) would block in enforce mode:`);
    for (const v of violations.slice(0, SUMMARY_MAX_LINES)) lines.push(`- \`${v.file}\``);
    if (violations.length > SUMMARY_MAX_LINES) {
      lines.push(`- … and ${violations.length - SUMMARY_MAX_LINES} more`);
    }
    return lines.join('\n');
  }
  if (violations.length === 0 && !ownerApprovedForbidden.length) {
    lines.push('No forbidden paths.');
  }
  if (violations.length > 0) {
    lines.push(`${violations.length} forbidden path(s):`);
    for (const v of violations.slice(0, SUMMARY_MAX_LINES)) lines.push(`- \`${v.file}\``);
  }
  if (ownerApprovedForbidden.length > 0) {
    const reviewId = scopeAckReview && scopeAckReview.id;
    const heading = reviewId
      ? `Forbidden — owner-approved (review #${reviewId}):`
      : 'Forbidden — owner-approved:';
    lines.push('', heading);
    for (const file of ownerApprovedForbidden.slice(0, SUMMARY_MAX_LINES)) lines.push(`- \`${file}\``);
  }
  return lines.join('\n') || 'No forbidden paths.';
}

/**
 * Config or GitHub list failures on the non-plan path (#1980).
 * @param {string} context
 * @param {Error|string} err
 * @param {'report-only'|'enforce'} mode
 */
function nonPlanInfrastructureOutcome(context, err, mode) {
  const message = err instanceof Error ? err.message : String(err);
  const summary = `Non-plan ${context} failed: ${message}`;
  if (mode === 'report-only') {
    return { conclusion: 'success', title: 'error-advisory', summary, planId: null };
  }
  return { conclusion: 'failure', title: 'error', summary, planId: null };
}

function nonPlanEvaluationToResult(evaluation, planId = null) {
  return {
    conclusion: evaluation.conclusion,
    title: evaluation.title,
    summary: evaluation.summary,
    planId,
    scopeAckReviewId: evaluation.scopeAckReviewId,
  };
}

module.exports = {
  evaluateNonPlanForbidden,
  forbiddenGateMode,
  nonPlanEvaluationToResult,
  nonPlanInfrastructureOutcome,
  renderForbiddenPathSummary,
};