#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COORDINATION_TITLE,
  ensureMarkerComment,
  renderIssueBody,
  parseArgs,
} = require('./uat_coordinator_bootstrap');
const { STATE_MARKER } = require('./lib/uat_queue_constants');
const {
  createEmptyState,
  enqueueEntry,
  parseStateFromCommentBody,
  renderStateCommentBody,
} = require('./lib/uat_queue_lib');
const { commitStateMutation } = require('./lib/uat_queue_sync');

test('COORDINATION_TITLE is stable', () => {
  assert.equal(COORDINATION_TITLE, '[uat-coordinator] UAT deploy queue');
});

test('renderIssueBody includes issue number in checklist', () => {
  const body = renderIssueBody(313, 'AgathaTrack', 'AgathaTrack');
  assert.match(body, /UAT_COORDINATION_ISSUE=313/);
  assert.match(body, /uat-coordinator-bootstrap\.md/);
  assert.ok(body.includes('github.com/AgathaTrack/AgathaTrack'));
});

test('parseArgs rejects invalid --issue', () => {
  assert.throws(() => parseArgs(['--issue']), /--issue requires/);
  assert.throws(() => parseArgs(['--issue', '0']), /--issue must be a positive integer/);
  assert.throws(() => parseArgs(['--issue', 'abc']), /--issue must be a positive integer/);
});

test('parseArgs defaults', () => {
  const flags = parseArgs([]);
  assert.equal(flags.write, false);
  assert.equal(flags.pin, false);
  assert.equal(flags.issue, null);
});

test('parseArgs reads flags', () => {
  const flags = parseArgs(['--write', '--pin', '--issue', '313']);
  assert.equal(flags.write, true);
  assert.equal(flags.pin, true);
  assert.equal(flags.issue, 313);
});

/**
 * Fake issue with GitHub comment semantics. `save` without a comment id upserts
 * like `saveStateToIssue` (PATCHes the first marker it finds). `create` POSTs.
 * `race` runs one enqueue writer at the first listed call point, after the
 * bootstrap's own read and before its write, which is the interleaving under test.
 */
function createIssueWithRace({ racePoints }) {
  const comments = [];
  let nextId = 1;
  let fired = false;
  const markers = () => comments.filter((comment) => comment.body.includes(STATE_MARKER));
  const fake = {
    comments,
    newestState() {
      const newest = markers().at(-1);
      return newest ? parseStateFromCommentBody(newest.body) : null;
    },
    async load() {
      const newest = markers().at(-1);
      if (!newest) {
        return { state: createEmptyState(), commentId: null, commentUpdatedAt: null };
      }
      return { state: parseStateFromCommentBody(newest.body), commentId: newest.id, commentUpdatedAt: null };
    },
    async list() {
      await raceAt('list');
      return markers().map((comment) => ({ id: comment.id, body: comment.body }));
    },
    async create(_issueNumber, state) {
      await raceAt('create');
      const comment = { id: nextId, body: renderStateCommentBody(state) };
      nextId += 1;
      comments.push(comment);
      return comment.id;
    },
    async save(_issueNumber, state, _token, commentId = null) {
      if (commentId) {
        comments.find((comment) => comment.id === commentId).body = renderStateCommentBody(state);
        return commentId;
      }
      await raceAt('save');
      const existing = markers()[0];
      if (existing) {
        existing.body = renderStateCommentBody(state);
        return existing.id;
      }
      return fake.create(_issueNumber, state);
    },
    async remove(commentId) {
      comments.splice(comments.findIndex((comment) => comment.id === commentId), 1);
    },
  };
  async function raceAt(point) {
    if (fired || !racePoints.includes(point)) {
      return;
    }
    fired = true;
    await commitStateMutation({
      issueNumber: 2573,
      loadState: () => fake.load(),
      saveState: (...args) => fake.save(...args),
      mutate(state) {
        return enqueueEntry(state, {
          mergeSha: 'sha-live',
          prNumber: 9,
          enqueuedBy: 'pr-9',
          enqueuedAt: '2026-11-27T00:00:00.000Z',
        });
      },
    });
  }
  return fake;
}

test('bootstrap creates an empty marker when the issue has none', async () => {
  const fake = createIssueWithRace({ racePoints: [] });
  const result = await ensureMarkerComment(2573, 'token', true, fake);
  assert.equal(result.initialized, true);
  assert.equal(fake.comments.length, 1);
  assert.deepEqual(fake.newestState().entries, []);
});

test('bootstrap init does not wipe an enqueue that lands before its write', async () => {
  const fake = createIssueWithRace({ racePoints: ['list', 'create', 'save'] });
  const result = await ensureMarkerComment(2573, 'token', true, fake);
  assert.equal(result.initialized, false);
  assert.deepEqual(fake.newestState().entries.map((entry) => entry.merge_sha), ['sha-live']);
  assert.equal(fake.comments.length, 1);
});

test('bootstrap init removes its empty marker when an enqueue lands after its check', async () => {
  const fake = createIssueWithRace({ racePoints: ['create', 'save'] });
  const result = await ensureMarkerComment(2573, 'token', true, fake);
  assert.equal(result.initialized, false);
  assert.deepEqual(fake.newestState().entries.map((entry) => entry.merge_sha), ['sha-live']);
  assert.equal(fake.comments.length, 1);
});
