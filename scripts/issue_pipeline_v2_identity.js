'use strict';

const { rest } = require('../.github/scripts/github-project-lib');
const { agentLogins } = require('./issue_pipeline_v2_config');

/**
 * Writes are allowed only when the token belongs to a configured engine identity (#2385: the
 * engine never writes as a listed agent, so its writes can be told apart from an agent breaking
 * the "agents never write Stage" rule). Fails closed on every doubt: no identity configured, the
 * lookup failing, or a login that is not on the list.
 * @returns {Promise<{ ok: boolean, reason?: string, login?: string }>}
 */
async function checkEngineIdentity({ token, config, restFn = rest }) {
  const allowed = config.engine?.logins || [];
  if (allowed.length === 0) {
    return { ok: false, reason: 'no-engine-identity-configured' };
  }
  let login = null;
  try {
    login = (await restFn('GET', '/user', token))?.login || null;
  } catch {
    return { ok: false, reason: 'identity-lookup-failed' };
  }
  if (!login || !allowed.includes(login)) {
    return { ok: false, reason: 'token-not-engine-identity', login };
  }
  if (agentLogins(config).includes(login)) {
    return { ok: false, reason: 'engine-identity-matches-agent-actsAs', login };
  }
  return { ok: true, login };
}

/** Real writes need `on` mode and a verified engine identity. Everything else is a dry run. */
function writesAllowed(mode, identity) {
  return mode === 'on' && Boolean(identity?.ok);
}

module.exports = { checkEngineIdentity, writesAllowed };
