'use strict';

/**
 * Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set when the
 * process starts (Node >= 22.21; setting it at runtime has no effect). Node also does not
 * read ALL_PROXY. Sandboxed agent sessions reach GitHub only through an egress proxy that
 * injects credentials, so a direct fetch is refused with 401 "Bad credentials".
 *
 * Scripts that call GitHub with fetch call reexecWithEnvProxy() at the top of the file.
 * When a proxy is configured and the flag is missing, the script re-runs itself once in a
 * child process with the flag set and exits with the child's status. ALL_PROXY is mapped to
 * HTTPS_PROXY for the child, because Node ignores ALL_PROXY. Only http(s) proxy URLs are
 * supported; a SOCKS-only setup is not handled. Without a proxy (GitHub Actions, local runs)
 * nothing changes.
 */

const { spawnSync } = require('child_process');

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];

function proxyReexecNeeded(env = process.env) {
  const hasProxy = PROXY_VARS.some((name) => Boolean(env[name]));
  return hasProxy && env.NODE_USE_ENV_PROXY !== '1';
}

/** Environment for the child: the flag is set, and ALL_PROXY is copied to HTTPS_PROXY when needed. */
function childEnv(env = process.env) {
  const out = { ...env, NODE_USE_ENV_PROXY: '1' };
  if (!env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = env.ALL_PROXY || env.all_proxy;
    if (proxy) out.HTTPS_PROXY = proxy;
  }
  return out;
}

function reexecArgs({ argv = process.argv, execArgv = process.execArgv } = {}) {
  return [...execArgv, ...argv.slice(1)];
}

/**
 * @returns {boolean} true when the process re-ran itself (the caller should stop).
 */
function reexecWithEnvProxy({
  argv = process.argv,
  execArgv = process.execArgv,
  env = process.env,
  exit = process.exit,
  spawn = spawnSync,
} = {}) {
  if (!proxyReexecNeeded(env)) return false;
  const child = spawn(process.execPath, reexecArgs({ argv, execArgv }), {
    stdio: 'inherit',
    env: childEnv(env),
  });
  if (child.error) throw child.error;
  exit(child.status === null ? 1 : child.status);
  return true;
}

module.exports = { proxyReexecNeeded, childEnv, reexecArgs, reexecWithEnvProxy };
