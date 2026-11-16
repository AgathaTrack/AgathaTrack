#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queueBugbotReview } = require('./cursor_bugbot_api');

test('queueBugbotReview posts prUrl', async () => {
  let called = null;
  const fetchImpl = async (url, options) => {
    called = { url, options };
    return { ok: true, status: 200, text: async () => JSON.stringify({ outcome: 'success', request_id: 'x' }) };
  };
  await queueBugbotReview({
    prUrl: 'https://github.com/o/r/pull/1',
    apiKey: 'key',
    fetchImpl,
  });
  assert.match(called.url, /bugbot\/review$/);
  assert.equal(JSON.parse(called.options.body).prUrl, 'https://github.com/o/r/pull/1');
});