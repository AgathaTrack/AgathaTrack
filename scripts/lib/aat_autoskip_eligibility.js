'use strict';

const { isForbiddenPath } = require('../../.github/scripts/agent-safety-lib');
const { globToRegExp } = require('./execute_plan_schema');

/**
 * True when every changed path matches a low-risk glob and none is sensitive (#2514 P3).
 * @param {string[]} changedPaths
 * @param {string[]} globs
 * @returns {{ eligible: boolean, reason?: string, path?: string }}
 */
function pathsEligible(changedPaths, globs) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return { eligible: false, reason: 'empty' };
  }
  if (!Array.isArray(globs) || globs.length === 0) {
    return { eligible: false, reason: 'no-globs' };
  }
  for (const filePath of changedPaths) {
    if (isForbiddenPath(filePath)) {
      return { eligible: false, reason: 'forbidden', path: filePath };
    }
    if (!globs.some((glob) => globToRegExp(glob).test(filePath))) {
      return { eligible: false, reason: 'outside-glob', path: filePath };
    }
  }
  return { eligible: true };
}

function autoSkipEligible(facts, config) {
  if (facts.delivery?.changedPathsError) {
    return { eligible: false, reason: 'error' };
  }
  return pathsEligible(facts.delivery?.changedPaths, config?.aat?.autoSkip?.globs);
}

module.exports = { pathsEligible, autoSkipEligible };