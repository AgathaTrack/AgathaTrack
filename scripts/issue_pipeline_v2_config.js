'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '.github', 'pipeline-agents.json');
const KNOWN_METHODS = new Set(['PR', 'light-plan', 'execute-plan']);
const ID_PATTERN = /^[A-Za-z0-9-]+$/;
const LIMIT_KEYS = [
  'wip',
  'reviewTimeoutMin',
  'ackWindowMin',
  'stalledInactivityHours',
  'noConvergenceVotes',
  'followUpMaxDepth',
];

function normalizeAgentEntry(raw) {
  const login = typeof raw?.login === 'string' ? raw.login : null;
  const id = typeof raw?.id === 'string' ? raw.id : login;
  const actsAs = typeof raw?.actsAs === 'string' ? raw.actsAs : login || id;
  const normalized = {
    id,
    actsAs,
    runner: raw.runner,
    methods: Array.isArray(raw.methods) ? raw.methods : [],
  };
  if (typeof raw?.model === 'string' && raw.model.length > 0) {
    normalized.model = raw.model;
  }
  if (login) {
    normalized.login = login;
  }
  return normalized;
}

/**
 * Validate the reviewed agents file (#2385). Throws with every problem found so a bad edit
 * fails in CI, not on the first tick. Agents are normalized to `{ id, actsAs, runner, methods }`;
 * legacy rows with `login` only keep that login as both `id` and `actsAs`.
 */
function validateConfig(config) {
  const problems = [];
  const agents = Array.isArray(config?.agents) ? config.agents : [];
  if (agents.length < 2) {
    problems.push('at least two listed agents are required (a review needs two)');
  }
  const idSeen = new Set();
  const actsAsSeen = new Set();
  const normalized = [];
  for (const raw of agents) {
    if (!raw?.login && !raw?.id) {
      problems.push('every agent needs a login or an id');
      continue;
    }
    const agent = normalizeAgentEntry(raw);
    if (!agent.id || !ID_PATTERN.test(agent.id)) {
      problems.push(`${agent.id || '(missing)'}: id must match [A-Za-z0-9-]+`);
    } else if (idSeen.has(agent.id)) {
      problems.push(`duplicate agent id ${agent.id}`);
    } else {
      idSeen.add(agent.id);
    }
    if (!agent.actsAs) {
      problems.push(`${agent.id}: actsAs is required`);
    } else {
      actsAsSeen.add(agent.actsAs);
    }
    const methods = agent.methods;
    if (methods.length === 0) {
      problems.push(`${agent.id}: methods must not be empty`);
    }
    for (const method of methods) {
      if (!KNOWN_METHODS.has(method)) {
        problems.push(`${agent.id}: unknown method ${method}`);
      }
    }
    normalized.push(agent);
  }
  const engineLogins = config?.engine?.logins;
  if (!Array.isArray(engineLogins) || engineLogins.some((login) => typeof login !== 'string')) {
    problems.push('engine.logins must be a list of logins (may be empty)');
  } else {
    for (const login of engineLogins) {
      if (idSeen.has(login)) {
        problems.push(`engine identity ${login} must not be a listed agent id`);
      }
      if (actsAsSeen.has(login)) {
        problems.push(`engine identity ${login} must not match an agent actsAs login`);
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
  config.agents = normalized;
  return config;
}

function entryId(agent) {
  return agent?.id || agent?.login || null;
}

function entryActsAs(agent) {
  return agent?.actsAs || agent?.login || agent?.id || null;
}

/** Resolve a pool id from markers, legacy login fields, or actsAs (first match in config order). */
function resolveAgent(config, key) {
  if (!key) {
    return null;
  }
  for (const agent of config.agents || []) {
    if (entryId(agent) === key || agent.login === key) {
      return agent;
    }
  }
  return (config.agents || []).find((agent) => entryActsAs(agent) === key) || null;
}

function agentActsAs(config, idOrKey) {
  const agent = resolveAgent(config, idOrKey);
  return agent ? entryActsAs(agent) : null;
}

/** Agents with `method` whose runner the engine can start itself. */
function launchableAgents(config, method) {
  return (config.agents || [])
    .filter(
      (agent) =>
        (agent.methods || []).includes(method) &&
        agent.runner &&
        (config.launchRunners || []).includes(agent.runner),
    )
    .map((agent) => entryId(agent));
}

/** Pool ids in config order. */
function agentIds(config) {
  return (config.agents || []).map((agent) => entryId(agent));
}

/**
 * GitHub logins the pool posts as (`actsAs`). Use for reactions, body edits and comment authorship.
 * While each id has its own actsAs this matches the old login list; shared logins land in PR 2.
 */
function agentLogins(config) {
  return [...new Set((config.agents || []).map((agent) => entryActsAs(agent)).filter(Boolean))];
}

/**
 * Ids whose runner the engine can start (the doorbell set). Pickup rotation draws only from these.
 */
function startableIds(config) {
  return (config.agents || [])
    .filter((agent) => agent.runner && (config.launchRunners || []).includes(agent.runner))
    .map((agent) => entryId(agent));
}

/** @deprecated use startableIds */
function selfStartingLogins(config) {
  return startableIds(config);
}

/** GitHub logins shared by more than one pool id (signed verdicts required). */
function sharedActsAs(config) {
  const counts = new Map();
  for (const agent of config.agents || []) {
    const login = entryActsAs(agent);
    if (login) {
      counts.set(login, (counts.get(login) || 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([login]) => login);
}

function loadConfig(file = DEFAULT_CONFIG_PATH) {
  return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  ID_PATTERN,
  KNOWN_METHODS,
  normalizeAgentEntry,
  validateConfig,
  loadConfig,
  entryId,
  entryActsAs,
  resolveAgent,
  agentActsAs,
  agentIds,
  agentLogins,
  launchableAgents,
  startableIds,
  selfStartingLogins,
  sharedActsAs,
};