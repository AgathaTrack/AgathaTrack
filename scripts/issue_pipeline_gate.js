'use strict';

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

module.exports = {
  hasLabel,
  isPipelineIssue,
};