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
  // The engine writes under its own identity, never a listed agent's (#2385). An empty list is
  // allowed while the owner has not picked one: the engine then trusts no request comment.
  const engineLogins = config?.engine?.logins;
  if (!Array.isArray(engineLogins) || engineLogins.some((login) => typeof login !== 'string')) {
    problems.push('engine.logins must be a list of logins (may be empty)');
  } else {
    for (const login of engineLogins) {
      if (seen.has(login)) {
        problems.push(`engine identity ${login} must not be a listed agent`);
      }
    }
  }
  const runners = config?.launchRunners;
  if (!Array.isArray(runners) || runners.length === 0 || runners.some((r) => typeof r !== 'string')) {
    problems.push('launchRunners must be a non-empty list of runner names the engine can start');
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

/** Agents with `method` whose runner the engine can start itself. */
function launchableAgents(config, method) {
  return config.agents
    .filter((agent) => agent.methods.includes(method) && config.launchRunners.includes(agent.runner))
    .map((agent) => agent.login);
}

/** Logins of the listed agents, in config order. */
function agentLogins(config) {
  return config.agents.map((agent) => agent.login);
}

/**
 * Logins whose runner the engine can start (the doorbell set). Pickup rotation (spec, review, intent
 * review) draws only from these: an agent the engine cannot ring would sit on the request until the
 * timeout, then be reassigned, and finally stall the issue.
 */
function selfStartingLogins(config) {
  return config.agents.filter((agent) => config.launchRunners.includes(agent.runner)).map((agent) => agent.login);
}

function loadConfig(file = DEFAULT_CONFIG_PATH) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { DEFAULT_CONFIG_PATH, KNOWN_METHODS, validateConfig, loadConfig, agentLogins, launchableAgents, selfStartingLogins };
