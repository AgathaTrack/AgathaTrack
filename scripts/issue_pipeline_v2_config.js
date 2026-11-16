'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '.github', 'pipeline-agents.json');
const KNOWN_METHODS = new Set(['PR', 'light-plan', 'execute-plan']);
const LIMIT_KEYS = [
  'wip',
  'reviewTimeoutMin',
  'ackWindowMin',
  'stalledInactivityHours',
  'noConvergenceVotes',
  'followUpMaxDepth',
];

/**
 * Validate the reviewed agents file (#2385). Throws with every problem found so a bad edit
 * fails in CI, not on the first tick.
 */
function validateConfig(config) {
  const problems = [];
  const agents = Array.isArray(config?.agents) ? config.agents : [];
  if (agents.length < 2) {
    problems.push('at least two listed agents are required (a review needs two)');
  }
  const seen = new Set();
  for (const agent of agents) {
    if (!agent?.login || typeof agent.login !== 'string') {
      problems.push('every agent needs a login');
      continue;
    }
    if (seen.has(agent.login)) {
      problems.push(`duplicate agent ${agent.login}`);
    }
    seen.add(agent.login);
    const methods = Array.isArray(agent.methods) ? agent.methods : [];
    if (methods.length === 0) {
      problems.push(`${agent.login}: methods must not be empty`);
    }
    for (const method of methods) {
      if (!KNOWN_METHODS.has(method)) {
        problems.push(`${agent.login}: unknown method ${method}`);
      }
    }
  }
  const limits = config?.limits || {};
  for (const key of LIMIT_KEYS) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0) {
      problems.push(`limits.${key} must be a positive number`);
    }
  }
  const backoff = limits.launchBackoffMin;
  if (!Array.isArray(backoff) || backoff.length === 0 || backoff.some((n) => !(n > 0))) {
    problems.push('limits.launchBackoffMin must be a non-empty list of positive numbers');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid pipeline-agents.json:\n- ${problems.join('\n- ')}`);
  }
  return config;
}

function loadConfig(file = DEFAULT_CONFIG_PATH) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { DEFAULT_CONFIG_PATH, KNOWN_METHODS, validateConfig, loadConfig };
