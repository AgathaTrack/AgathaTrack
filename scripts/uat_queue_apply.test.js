#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmptyState,
  enqueueEntry,
  findActiveEntryByPr,
  applyDeployResult,
  UatQueueError,
} = require('./lib/uat_queue_lib');
const { enqueueMutation } = require('./lib/uat_queue_apply');
const { updateQueueState } = require('./lib/uat_queue_sync');

test('findActiveEntryByPr ignores superseded entries', () => {
  const state = createEmptyState();
  enqueueEntry(state, { mergeSha: 'abc', prNumber: 361, enqueuedBy: 'pr-361' });
  state.entries[0].state = 'superseded';
  enqueueEntry(state, { mergeSha: 'def', prNumber: 361, enqueuedBy: 'pr-361' });
  const active = findActiveEntryByPr(state, 361);
  assert.equal(active.merge_sha, 'def');
});

test('applyDeployResult matches by PR when entry was backfilled with uat tag', () => {
  const state = createEmptyState();
  enqueueEntry(state, {
    mergeSha: '4a9036584b7f4dc0ccb446b93022c8f4903d2067',
    prNumber: 361,
    enqueuedBy: 'pr-361',
    uatTag: 'uat-260725-361',
  });
  const result = applyDeployResult(state, {
    deployRef: 'uat-260725-361',
    conclusion: 'failure',
    deployRunId: '30162576990',
    gateSummaryRef: 'https://example.com/runs/30162576990',
    gateFailureClass: 'infra_only',
  });
  assert.equal(result.skipped, false);
  assert.equal(result.entry.state, 'infra_failed');
  assert.equal(result.entry.pr_number, 361);
});

/**
 * In-memory stand-in for the marker comment. Each load and save yields once, so
 * overlapping operations interleave the way two workflow runs would.
 */
function fakeMarkerStore() {
  let stored = JSON.stringify(createEmptyState());
  const log = { loads: 0, saves: 0 };
  const store = {
    async load() {
      log.loads += 1;
      await Promise.resolve();
      return { state: JSON.parse(stored), issueNumber: 1, commentId: 1 };
    },
    async save(issueNumber, state) {
      log.saves += 1;
      await Promise.resolve();
      stored = JSON.stringify(state);
      return { issueNumber, commentId: 1 };
    },
  };
  return { store, log, current: () => JSON.parse(stored) };
}

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('two overlapping enqueue writes both survive the lost-update race', async () => {
  const { store, log, current } = fakeMarkerStore();
  const [a, b] = await Promise.all([
    updateQueueState(1, enqueueMutation({ mergeSha: SHA_A, prNumber: 101, enqueuedBy: 'pr-101' }), { store }),
    updateQueueState(1, enqueueMutation({ mergeSha: SHA_B, prNumber: 102, enqueuedBy: 'pr-102' }), { store }),
  ]);

  assert.equal(a.result.created, true);
  assert.equal(b.result.created, true);
  assert.deepEqual(current().entries.map((e) => e.merge_sha).sort(), [SHA_A, SHA_B]);
  assert.ok(log.loads > 2, 'a lost write must be detected by re-read and reapplied');
});

test('a duplicate enqueue event for the same merge leaves one entry and reports created false', async () => {
  const { store, current } = fakeMarkerStore();
  const input = { mergeSha: SHA_A, prNumber: 103, enqueuedBy: 'pr-103' };

  const first = await updateQueueState(1, enqueueMutation(input), { store });
  const second = await updateQueueState(1, enqueueMutation(input), { store });

  assert.equal(first.result.created, true);
  assert.equal(second.result.created, false);
  assert.equal(second.written, false);
  assert.equal(current().entries.length, 1);
});

test('overlapping duplicate enqueue events still leave exactly one entry', async () => {
  const { store, current } = fakeMarkerStore();
  const input = { mergeSha: SHA_A, prNumber: 104, enqueuedBy: 'pr-104' };

  await Promise.all([
    updateQueueState(1, enqueueMutation(input), { store }),
    updateQueueState(1, enqueueMutation(input), { store }),
  ]);

  assert.equal(current().entries.length, 1);
});

test('a store that never keeps the write makes the helper throw after bounded attempts', async () => {
  const { store, log } = fakeMarkerStore();
  store.save = async () => {
    log.saves += 1;
    return { issueNumber: 1, commentId: 1 };
  };

  await assert.rejects(
    updateQueueState(1, enqueueMutation({ mergeSha: SHA_A, prNumber: 105 }), { store, attempts: 3 }),
    (error) => error instanceof UatQueueError && error.code === 'uat_queue_write_conflict',
  );
  assert.equal(log.saves, 3);
});

test('write: false previews the mutation without saving', async () => {
  const { store, log, current } = fakeMarkerStore();

  const outcome = await updateQueueState(
    1,
    enqueueMutation({ mergeSha: SHA_A, prNumber: 106 }),
    { store, write: false },
  );

  assert.equal(outcome.result.created, true);
  assert.equal(outcome.written, false);
  assert.equal(log.saves, 0);
  assert.equal(current().entries.length, 0);
});
