import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SHARD_GLOBAL_TIMEOUT_BUFFER_SEC,
  SHARD_LOADS,
  SHARD_TOTAL,
  shardGlobalTimeoutMs,
} from './shard-files.mjs';

test('shardGlobalTimeoutMs adds headroom under the Actions job cap', () => {
  assert.equal(shardGlobalTimeoutMs(1), (SHARD_LOADS[0] + SHARD_GLOBAL_TIMEOUT_BUFFER_SEC) * 1000);
  assert.equal(shardGlobalTimeoutMs(SHARD_TOTAL), (SHARD_LOADS[SHARD_TOTAL - 1] + SHARD_GLOBAL_TIMEOUT_BUFFER_SEC) * 1000);
});

test('shardGlobalTimeoutMs rejects out-of-range shard index', () => {
  assert.throws(() => shardGlobalTimeoutMs(0), /1-/);
  assert.throws(() => shardGlobalTimeoutMs(SHARD_TOTAL + 1), /1-/);
});