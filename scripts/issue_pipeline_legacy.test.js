'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isLegacyDispatchRetired } = require('./issue_pipeline_legacy');

test('legacy dispatch retired only when ISSUE_PIPELINE is on', () => {
  assert.equal(isLegacyDispatchRetired('off'), false);
  assert.equal(isLegacyDispatchRetired('dry-run'), false);
  assert.equal(isLegacyDispatchRetired('on'), true);
  assert.equal(isLegacyDispatchRetired(' ON '), true);
});