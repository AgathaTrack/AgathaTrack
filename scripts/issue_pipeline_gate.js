'use strict';

const AUTOMATION_COLUMNS = new Set([
  'To do',
  'In Analysis',
  'Ready',
  'In progress',
]);

function hasLabel(labels, name) {
  return (labels || []).includes(name);
}

/**
 * Issues in the new pipeline during build/soak carry `pipeline-beta`.
 * After cutover (`ISSUE_PIPELINE=on`), all project issues are eligible.
 */
function isPipelineIssue(labels, mode) {
  const normalized = String(mode || 'off').toLowerCase();
  if (hasLabel(labels, 'pipeline-beta')) {
    return true;
  }
  return normalized === 'on';
}

function isExecutePlanControlTitle(title) {
  return /^(?:\[)?execute-plan\b/i.test(String(title || '').trim());
}

/**
 * Dispatcher tick eligibility (repair #2363 §2.6): not owner-programme, not execute-plan control,
 * only active pipeline columns.
 */
function isDispatcherEligibleIssue(issue, mode) {
  const labels = issue.labels || [];
  if (!isPipelineIssue(labels, mode)) {
    return false;
  }
  if (hasLabel(labels, 'owner-programme')) {
    return false;
  }
  if (isExecutePlanControlTitle(issue.title)) {
    return false;
  }
  if (!AUTOMATION_COLUMNS.has(issue.status)) {
    return false;
  }
  return true;
}

module.exports = {
  hasLabel,
  isPipelineIssue,
  isExecutePlanControlTitle,
  isDispatcherEligibleIssue,
  AUTOMATION_COLUMNS,
};