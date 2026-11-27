#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmptyState, enqueueEntry, ledgerHasLiveContent, UatQueueError } = require('./lib/uat_queue_lib');
const { syncEnqueueAfterMerge } = require('./lib/uat_queue_apply');
const { commitStateMutation } = require('./lib/uat_queue_sync');
const { reapplyDispatchLedger } = require('../.github/scripts/uat-coordinator-dispatch');

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
    saveState: (...args) => store.save(...args),
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
  assert.equal(first.entry.merge_sha === 'sha-aaa' || second.entry.merge_sha === 'sha-aaa', true);
  assert.equal(first.entry.merge_sha === 'sha-bbb' || second.entry.merge_sha === 'sha-bbb', true);
});

test('overlapping duplicate enqueues report created from the landed attempt', { timeout: 5000 }, async () => {
  const store = createClobberStore();
  const run = (enqueuedAt) => commitStateMutation({
    issueNumber: 2558,
    maxAttempts: 5,
    loadState: () => store.load(),
    saveState: (...args) => store.save(...args),
    mutate(state) {
      return enqueueEntry(state, {
        mergeSha: 'sha-same',
        prNumber: 7,
        enqueuedBy: 'pr-7',
        enqueuedAt,
      });
    },
  });
  const [first, second] = await Promise.all([
    run('2026-01-01T00:00:00.000Z'),
    run('2026-01-02T00:00:00.000Z'),
  ]);
  assert.equal(store.read().entries.length, 1);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
});

test('a save patches the comment id from the pre-write read', async () => {
  let revision = 0;
  let snapshot = createEmptyState();
  const patched = [];
  const store = {
    async load() {
      return {
        state: structuredClone(snapshot),
        commentId: 99,
        commentUpdatedAt: String(revision),
      };
    },
    async save(_issueNumber, state, _token, commentId) {
      patched.push(commentId);
      revision += 1;
      snapshot = structuredClone(state);
    },
  };
  const result = await enqueueOn(store, 'sha-patch', 3);
  assert.equal(result.created, true);
  assert.deepEqual(patched, [99]);
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

test('bootstrap keeps a ledger that only has an active watcher', () => {
  const state = createEmptyState();
  state.active_watcher = { holder: 'gha-1', lease_until: '2099-01-01T00:00:00.000Z', watching_seq: 1 };
  assert.equal(ledgerHasLiveContent(state), true);
  assert.equal(ledgerHasLiveContent(createEmptyState()), false);
});

test('dispatch reapply does not lease a missing entry', async () => {
  const state = createEmptyState();
  await reapplyDispatchLedger(state, {
    entry: { merge_sha: 'missing', seq: 9, state: 'failed' },
    nextState: {
      active_watcher: { holder: 'gha-2' },
      promote_hold: false,
    },
  });
  assert.equal(state.active_watcher, null);
});

test('dispatch reapply leases the live entry sequence', async () => {
  const state = createEmptyState();
  state.entries = [{
    seq: 4,
    pr_number: 4,
    merge_sha: 'abc',
    state: 'failed',
  }];
  await reapplyDispatchLedger(state, {
    entry: { merge_sha: 'abc', seq: 99, state: 'remedial' },
    nextState: {
      active_watcher: { holder: 'gha-2' },
      promote_hold: true,
      promote_hold_reason: 'deploy-uat failure run 2',
    },
  });
  assert.equal(state.entries[0].state, 'remedial');
  assert.equal(state.active_watcher.holder, 'gha-2');
  assert.equal(state.active_watcher.watching_seq, 4);
  assert.equal(state.promote_hold, true);
});

test('empty init skips when pre-save read finds live marker', async () => {
  let loadN = 0;
  const withEntry = createEmptyState();
  withEntry.entries.push({
    seq: 1,
    pr_number: 1,
    merge_sha: 'live',
    state: 'queued',
    enqueued_at: '2026-01-01T00:00:00.000Z',
    enqueued_by: 'pr-1',
  });
  const store = {
    async load() {
      loadN += 1;
      if (loadN <= 2) {
        return { state: createEmptyState(), commentId: null, commentUpdatedAt: null };
      }
      return {
        state: structuredClone(withEntry),
        commentId: 88,
        commentUpdatedAt: '1',
      };
    },
    async save() {
      assert.fail('save should not run when a live marker appeared');
    },
  };
  const result = await commitStateMutation({
    issueNumber: 2573,
    loadState: () => store.load(),
    saveState: (...args) => store.save(...args),
    mutate(state) {
      if (ledgerHasLiveContent(state)) {
        return { state, initialized: false };
      }
      return { state: createEmptyState(), initialized: true };
    },
  });
  assert.equal(result.written, false);
  assert.equal(result.initialized, false);
  assert.equal(result.state.entries.length, 1);
  assert.equal(result.state.entries[0].merge_sha, 'live');
});

test('marker_already_live when pre-save sees live ledger before empty write', async () => {
  let loadN = 0;
  const live = createEmptyState();
  live.entries.push({
    seq: 1,
    pr_number: 2,
    merge_sha: 'pre-save',
    state: 'queued',
    enqueued_at: '2026-01-01T00:00:00.000Z',
    enqueued_by: 'pr-2',
  });
  const store = {
    async load() {
      loadN += 1;
      if (loadN <= 2) {
        return { state: createEmptyState(), commentId: null, commentUpdatedAt: null };
      }
      if (loadN === 3) {
        return { state: structuredClone(live), commentId: 12, commentUpdatedAt: '1' };
      }
      return { state: structuredClone(live), commentId: 12, commentUpdatedAt: '1' };
    },
    async save() {
      assert.fail('save should not run when pre-save sees live content');
    },
  };
  const result = await commitStateMutation({
    issueNumber: 2573,
    loadState: () => store.load(),
    saveState: (...args) => store.save(...args),
    mutate() {
      return { state: createEmptyState(), initialized: true };
    },
  });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'marker_already_live');
  assert.equal(result.written, false);
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
