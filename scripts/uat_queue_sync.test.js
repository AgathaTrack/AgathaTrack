#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmptyState, UatQueueError } = require('./lib/uat_queue_lib');
const { syncEnqueueAfterMerge } = require('./lib/uat_queue_apply');
const { commitStateMutation } = require('./lib/uat_queue_sync');

function defer() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createMemoryStore() {
  let revision = 0;
  let snapshot = createEmptyState();
  return {
    read() {
      return structuredClone(snapshot);
    },
    async load() {
      return {
        state: structuredClone(snapshot),
        commentId: 4,
        commentUpdatedAt: String(revision),
      };
    },
    async save(_issueNumber, state) {
      revision += 1;
      snapshot = structuredClone(state);
    },
  };
}

/**
 * Both writers pass the pre-save re-read against the same snapshot.
 * The second save overwrites the first. The first writer must observe that
 * on read-back and reapply.
 */
function createClobberStore() {
  let revision = 0;
  let snapshot = createEmptyState();
  let entered = 0;
  const secondEntered = defer();
  const firstApplied = defer();
  const secondApplied = defer();
  return {
    read() {
      return structuredClone(snapshot);
    },
    async load() {
      return {
        state: structuredClone(snapshot),
        commentId: 4,
        commentUpdatedAt: String(revision),
      };
    },
    async save(_issueNumber, state) {
      entered += 1;
      const n = entered;
      if (n === 1) {
        await secondEntered.promise;
        revision += 1;
        snapshot = structuredClone(state);
        firstApplied.resolve();
        await secondApplied.promise;
        return;
      }
      if (n === 2) {
        secondEntered.resolve();
        await firstApplied.promise;
        revision += 1;
        snapshot = structuredClone(state);
        secondApplied.resolve();
        return;
      }
      revision += 1;
      snapshot = structuredClone(state);
    },
  };
}

function enqueueOn(store, mergeSha, prNumber, maxAttempts) {
  return syncEnqueueAfterMerge({
    mergeSha,
    prNumber,
    enqueuedBy: `pr-${prNumber}`,
    issueNumber: 2558,
    maxAttempts,
    loadState: () => store.load(),
    saveState: (issueNumber, state) => store.save(issueNumber, state),
  });
}

test('two interleaved enqueues both survive', { timeout: 5000 }, async () => {
  const store = createClobberStore();
  const [first, second] = await Promise.all([
    enqueueOn(store, 'sha-aaa', 11),
    enqueueOn(store, 'sha-bbb', 22),
  ]);
  const shas = store.read().entries.map((entry) => entry.merge_sha).sort();
  assert.deepEqual(shas, ['sha-aaa', 'sha-bbb']);
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.equal(first.entry.merge_sha === 'sha-aaa' || second.entry.merge_sha === 'sha-aaa', true);
  assert.equal(first.entry.merge_sha === 'sha-bbb' || second.entry.merge_sha === 'sha-bbb', true);
});

test('duplicate enqueue for the same mergeSha is idempotent', async () => {
  const store = createMemoryStore();
  const first = await enqueueOn(store, 'sha-same', 7);
  const second = await enqueueOn(store, 'sha-same', 7);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(store.read().entries.length, 1);
  assert.equal(store.read().entries[0].merge_sha, 'sha-same');
});

test('a skipped mutation does not create a marker', async () => {
  let saves = 0;
  const store = {
    async load() {
      return { state: createEmptyState(), commentId: null, commentUpdatedAt: null };
    },
    async save() {
      saves += 1;
    },
  };
  const result = await commitStateMutation({
    issueNumber: 2558,
    loadState: () => store.load(),
    saveState: () => store.save(),
    mutate(state) {
      return { state, skipped: true, reason: 'no_matching_entry' };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.written, false);
  assert.equal(saves, 0);
});

test('a store that never converges throws', async () => {
  let saves = 0;
  const empty = createEmptyState();
  const store = {
    async load() {
      return {
        state: structuredClone(empty),
        commentId: 4,
        commentUpdatedAt: 'fixed',
      };
    },
    async save() {
      saves += 1;
    },
  };

  await assert.rejects(
    () => enqueueOn(store, 'sha-lost', 9, 3),
    (error) => {
      assert.ok(error instanceof UatQueueError);
      assert.equal(error.code, 'uat_queue_write_conflict');
      assert.match(error.message, /did not converge after 3 attempts/);
      return true;
    },
  );
  assert.equal(saves, 3);
});
