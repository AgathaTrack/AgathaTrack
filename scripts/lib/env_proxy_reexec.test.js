#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { proxyReexecNeeded, childEnv, reexecArgs, reexecWithEnvProxy } = require('./env_proxy_reexec');

test('proxyReexecNeeded is false without a proxy variable', () => {
  assert.equal(proxyReexecNeeded({}), false);
});

test('proxyReexecNeeded is true for HTTPS_PROXY or https_proxy without the flag', () => {
  assert.equal(proxyReexecNeeded({ HTTPS_PROXY: 'http://proxy:3128' }), true);
  assert.equal(proxyReexecNeeded({ https_proxy: 'http://proxy:3128' }), true);
});

test('proxyReexecNeeded is true for ALL_PROXY-only environments', () => {
  assert.equal(proxyReexecNeeded({ ALL_PROXY: 'http://proxy:3128' }), true);
  assert.equal(proxyReexecNeeded({ all_proxy: 'http://proxy:3128' }), true);
});

test('childEnv copies ALL_PROXY to HTTPS_PROXY when no HTTPS proxy is set', () => {
  const env = childEnv({ ALL_PROXY: 'http://proxy:3128', PATH: '/bin' });
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.ALL_PROXY, 'http://proxy:3128');
  assert.equal(env.PATH, '/bin');
});

test('childEnv keeps an existing HTTPS_PROXY and does not overwrite it with ALL_PROXY', () => {
  const env = childEnv({ HTTPS_PROXY: 'http://https-proxy:3128', ALL_PROXY: 'http://all:3128' });
  assert.equal(env.HTTPS_PROXY, 'http://https-proxy:3128');
});

test('childEnv passes NO_PROXY through unchanged', () => {
  const env = childEnv({ HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost' });
  assert.equal(env.NO_PROXY, 'localhost');
});

test('reexecWithEnvProxy maps ALL_PROXY into the child environment', () => {
  let childEnvSeen = null;
  reexecWithEnvProxy({
    argv: ['node', 'x.js'],
    execArgv: [],
    env: { ALL_PROXY: 'http://proxy:3128' },
    spawn: (cmd, args, options) => {
      childEnvSeen = options.env;
      return { status: 0 };
    },
    exit: () => {},
  });
  assert.equal(childEnvSeen.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(childEnvSeen.NODE_USE_ENV_PROXY, '1');
});

test('proxyReexecNeeded is false once NODE_USE_ENV_PROXY=1 is set (no loop)', () => {
  assert.equal(
    proxyReexecNeeded({ HTTPS_PROXY: 'http://proxy:3128', NODE_USE_ENV_PROXY: '1' }),
    false,
  );
});

test('reexecArgs keeps node flags and the script arguments, drops the node binary', () => {
  const args = reexecArgs({
    argv: ['/usr/bin/node', '/repo/scripts/github_issue_workflow.js', 'aat-fail', '--issue', '2271'],
    execArgv: ['--no-warnings'],
  });
  assert.deepEqual(args, [
    '--no-warnings',
    '/repo/scripts/github_issue_workflow.js',
    'aat-fail',
    '--issue',
    '2271',
  ]);
});

test('reexecWithEnvProxy does nothing when no proxy is configured', () => {
  let spawned = false;
  const result = reexecWithEnvProxy({
    argv: ['node', 'script.js'],
    execArgv: [],
    env: {},
    spawn: () => {
      spawned = true;
      return { status: 0 };
    },
    exit: () => assert.fail('must not exit'),
  });
  assert.equal(result, false);
  assert.equal(spawned, false);
});

test('reexecWithEnvProxy re-runs once with the flag set and passes the child status through', () => {
  const calls = [];
  let exitCode = null;
  const result = reexecWithEnvProxy({
    argv: ['node', '/repo/scripts/x.js', '--issue', '1'],
    execArgv: [],
    env: { HTTPS_PROXY: 'http://proxy:3128', PATH: '/bin' },
    spawn: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 3 };
    },
    exit: (code) => {
      exitCode = code;
    },
  });
  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['/repo/scripts/x.js', '--issue', '1']);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(calls[0].options.env.NODE_USE_ENV_PROXY, '1');
  assert.equal(calls[0].options.env.HTTPS_PROXY, 'http://proxy:3128');
  assert.equal(exitCode, 3);
});

test('reexecWithEnvProxy exits 1 when the child was killed (null status)', () => {
  let exitCode = null;
  reexecWithEnvProxy({
    argv: ['node', 'x.js'],
    execArgv: [],
    env: { HTTPS_PROXY: 'http://proxy:3128' },
    spawn: () => ({ status: null, signal: 'SIGKILL' }),
    exit: (code) => {
      exitCode = code;
    },
  });
  assert.equal(exitCode, 1);
});

test('reexecWithEnvProxy rethrows a spawn error instead of hiding it', () => {
  assert.throws(
    () =>
      reexecWithEnvProxy({
        argv: ['node', 'x.js'],
        execArgv: [],
        env: { HTTPS_PROXY: 'http://proxy:3128' },
        spawn: () => ({ error: new Error('spawn failed') }),
        exit: () => assert.fail('must not exit'),
      }),
    /spawn failed/,
  );
});
