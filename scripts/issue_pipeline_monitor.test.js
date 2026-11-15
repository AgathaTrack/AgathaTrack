'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMonitorTick } = require('./issue_pipeline_monitor');

test('applyMonitorTick dry-run does not call API', async () => {
  const result = await applyMonitorTick({
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    issueNumber: 1,
    token: 't',
    dryRun: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.action, 'monitor');
  assert.equal('apiKeyPresent' in result, false);
});