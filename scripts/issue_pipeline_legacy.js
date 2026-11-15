'use strict';

/**
 * Legacy human-reviewed / agent-dispatch workflows are disabled when the
 * assignee-driven dispatcher is fully live (issue-pipeline-dispatcher-spec §14.3).
 */
function isLegacyDispatchRetired(mode) {
  return String(mode || 'off').trim().toLowerCase() === 'on';
}

module.exports = {
  isLegacyDispatchRetired,
};