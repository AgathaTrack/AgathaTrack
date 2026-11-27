#!/usr/bin/env node
'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AGENT_INVOKED_FETCH_CLIS,
  checkAgentInvokedCliFile,
} = require('./env_proxy_agent_clis');

const REPO_ROOT = path.resolve(__dirname, '../..');

test('each agent-invoked fetch CLI has reexecWithEnvProxy before GitHub requires', () => {
  for (const rel of AGENT_INVOKED_FETCH_CLIS) {
    const result = checkAgentInvokedCliFile(REPO_ROOT, rel);
    assert.equal(result.ok, true, `${rel}: ${result.reason || 'ok'}`);
  }
});

test('transitive local requires reach GitHub (execute_plan_project)', () => {
  const { moduleReachesGithub } = require('./env_proxy_agent_clis');
  const abs = path.join(REPO_ROOT, 'scripts/lib/execute_plan_project.js');
  assert.equal(moduleReachesGithub(abs), true);
});