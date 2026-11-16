#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  COPILOT_REQUEST_GRACE_MS,
  classifyReviewer,
  assessCopilotStatus,
  normalizeReviewThreads,
  buildCollectReport,
  parsePrRef,
  readReviewThreadPage,
} = require('./lib/babysit_pr_reviews_lib');
const { CURSOR_REVIEW_MARKER } = require('./lib/pr_review_request_lib');

const COPILOT_BOT = 'copilot-pull-request-reviewer[bot]';

function thread(overrides = {}) {
  return {
    isResolved: false,
    reviewer: 'copilot',
    author: 'copilot-pull-request-reviewer',
    path: 'a.dart',
    line: 1,
    body: 'issue',
    url: 'https://example.com',
    commentCount: 1,
    ...overrides,
  };
}

test('classifyReviewer maps copilot logins and everyone else to human', () => {
  assert.equal(classifyReviewer('copilot-pull-request-reviewer'), 'copilot');
  assert.equal(classifyReviewer(COPILOT_BOT), 'copilot');
  assert.equal(classifyReviewer('Copilot'), 'copilot');
  assert.equal(classifyReviewer('cursor[bot]'), 'human');
  assert.equal(classifyReviewer('human-dev'), 'human');
});

test('assessCopilotStatus complete when copilot review exists', () => {
  const status = assessCopilotStatus({
    reviews: [{ user: { login: COPILOT_BOT }, body: 'overview' }],
    reviewComments: [{ user: { login: COPILOT_BOT }, body: 'nit' }],
    requestedReviewers: [],
  });
  assert.equal(status.state, 'complete');
  assert.equal(status.inlineCommentCount, 1);
});

test('assessCopilotStatus pending while Copilot is a requested reviewer (REST login "Copilot")', () => {
  const status = assessCopilotStatus({
    reviews: [],
    reviewComments: [],
    requestedReviewers: [{ login: 'Copilot', type: 'Bot' }],
  });
  assert.equal(status.state, 'pending');
  assert.equal(status.reason, 'review_requested');
});

test('assessCopilotStatus pending on a re-review even after an earlier review', () => {
  const status = assessCopilotStatus({
    reviews: [{ user: { login: COPILOT_BOT } }],
    reviewComments: [],
    requestedReviewers: [{ login: 'Copilot' }],
  });
  assert.equal(status.state, 'pending');
});

test('assessCopilotStatus absent when Copilot never involved', () => {
  const status = assessCopilotStatus({
    reviews: [{ user: { login: 'human-dev' } }],
    reviewComments: [],
    requestedReviewers: [{ login: 'human-dev' }],
    createdAt: '2026-11-02T10:00:00Z',
    now: Date.parse('2026-11-02T11:00:00Z'),
  });
  assert.equal(status.state, 'absent');
});

test('assessCopilotStatus pending on a just-opened PR before the ruleset request lands', () => {
  const createdAt = '2026-11-02T10:00:00Z';
  const young = assessCopilotStatus({
    reviews: [],
    reviewComments: [],
    requestedReviewers: [],
    createdAt,
    now: Date.parse(createdAt) + COPILOT_REQUEST_GRACE_MS - 1000,
  });
  assert.equal(young.state, 'pending');
  assert.equal(young.reason, 'awaiting_request');
  const old = assessCopilotStatus({
    reviews: [],
    reviewComments: [],
    requestedReviewers: [],
    createdAt,
    now: Date.parse(createdAt) + COPILOT_REQUEST_GRACE_MS,
  });
  assert.equal(old.state, 'absent');
});

test('normalizeReviewThreads maps graphql nodes', () => {
  const threads = normalizeReviewThreads([
    {
      isResolved: false,
      comments: {
        nodes: [
          {
            author: { login: 'copilot-pull-request-reviewer' },
            body: 'Fix this',
            path: 'lib/a.dart',
            line: 12,
            url: 'https://example.com/thread',
          },
        ],
      },
    },
  ]);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].reviewer, 'copilot');
  assert.equal(threads[0].path, 'lib/a.dart');
});

test('buildCollectReport: Copilot in progress with no threads yet is neither triage- nor merge-ready', () => {
  const report = buildCollectReport({
    prNumber: 2017,
    copilot: { state: 'pending', reason: 'review_requested', inlineCommentCount: 0 },
    threads: [],
  });
  assert.equal(report.readyForTriage, false);
  assert.equal(report.mergeReady, false);
  assert.match(report.warnings[0], /in progress/);
});

test('buildCollectReport: completed review with unresolved threads is triage-ready, not merge-ready', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'complete', reason: 'review_submitted', inlineCommentCount: 2 },
    threads: [thread(), thread({ reviewer: 'human', author: 'owner' }), thread({ isResolved: true })],
  });
  assert.equal(report.readyForTriage, true);
  assert.equal(report.mergeReady, false);
  assert.deepEqual(report.summary, { unresolvedCount: 2, copilotCount: 1, cursorCount: 0, humanCount: 1 });
  assert.equal(report.threads.length, 2);
});

test('buildCollectReport: merge-ready when review done and every thread resolved', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'complete', reason: 'review_submitted', inlineCommentCount: 1 },
    threads: [thread({ isResolved: true })],
  });
  assert.equal(report.mergeReady, true);
});

test('buildCollectReport: merge-ready when Copilot absent and no threads', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'absent', reason: 'no_review', inlineCommentCount: 0 },
    threads: [],
  });
  assert.equal(report.readyForTriage, true);
  assert.equal(report.mergeReady, true);
});

test('buildCollectReport: timeout with Copilot still pending flags Copilot unavailable, not merge-ready', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'pending', reason: 'review_requested', inlineCommentCount: 0 },
    threads: [thread({ reviewer: 'human', author: 'owner' })],
    timedOut: true,
  });
  assert.equal(report.timedOut, true);
  assert.equal(report.copilotUnavailable, true);
  assert.equal(report.readyForTriage, true);
  assert.equal(report.mergeReady, false);
  assert.match(report.warnings[0], /unavailable/);
});

test('classifyReviewer maps Cursor-marked comments from the agent identity to cursor', () => {
  const marked = `**must-fix** x\n\n${CURSOR_REVIEW_MARKER}`;
  assert.equal(classifyReviewer('pawpet-bot', marked, 'pawpet-bot'), 'cursor');
  assert.equal(classifyReviewer('pawpet-claude', marked, 'pawpet-bot'), 'human');
  assert.equal(classifyReviewer('pawpet-bot', marked), 'human');
  assert.equal(classifyReviewer('pawpet-bot', 'plain reply', 'pawpet-bot'), 'human');
  assert.equal(classifyReviewer(COPILOT_BOT, CURSOR_REVIEW_MARKER, 'pawpet-bot'), 'copilot');
});

test('normalizeReviewThreads labels Cursor fallback threads by the first comment', () => {
  const [normalized] = normalizeReviewThreads([
    {
      isResolved: false,
      comments: { nodes: [{ author: { login: 'pawpet-bot' }, body: `bug\n\n${CURSOR_REVIEW_MARKER}`, path: 'a.js', line: 3 }] },
    },
  ], { cursorLogin: 'pawpet-bot' });
  assert.equal(normalized.reviewer, 'cursor');
});

test('buildCollectReport: Cursor fallback pending blocks triage until the timeout', () => {
  const absentCopilot = { state: 'absent', reason: 'no_review', inlineCommentCount: 0 };
  const cursor = { state: 'pending', reason: 'review_running', inlineCommentCount: 0 };
  const running = buildCollectReport({ prNumber: 1, copilot: absentCopilot, cursor, threads: [] });
  assert.equal(running.readyForTriage, false);
  assert.equal(running.mergeReady, false);
  assert.match(running.warnings[0], /Cursor fallback review in progress/);

  const timedOut = buildCollectReport({ prNumber: 1, copilot: absentCopilot, cursor, threads: [], timedOut: true });
  assert.equal(timedOut.cursorUnavailable, true);
  assert.equal(timedOut.copilotUnavailable, false);
  assert.equal(timedOut.readyForTriage, true);
  assert.equal(timedOut.mergeReady, false);
});

test('buildCollectReport: completed Cursor review counts its unresolved threads', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'absent', reason: 'no_review', inlineCommentCount: 0 },
    cursor: { state: 'complete', reason: 'review_submitted', inlineCommentCount: 1 },
    threads: [thread({ reviewer: 'cursor', author: 'pawpet-bot' })],
  });
  assert.equal(report.readyForTriage, true);
  assert.equal(report.mergeReady, false);
  assert.equal(report.summary.cursorCount, 1);
  assert.equal(report.reviewers.cursor.state, 'complete');
});

test('buildCollectReport: a leftover Copilot request is superseded once the fallback took over', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'pending', reason: 'review_requested', inlineCommentCount: 0 },
    cursor: { state: 'complete', reason: 'review_submitted', inlineCommentCount: 0, reviewerLogin: 'pawpet-bot', supersedesCopilot: true },
    threads: [],
  });
  assert.equal(report.reviewers.copilot.state, 'skipped');
  assert.equal(report.reviewers.copilot.reason, 'superseded_by_cursor_fallback');
  assert.equal(report.mergeReady, true);
});

test('buildCollectReport: an unavailable fallback is triage-ready but flags review unavailable (exit 3)', () => {
  const report = buildCollectReport({
    prNumber: 1,
    copilot: { state: 'pending', reason: 'review_requested', inlineCommentCount: 0 },
    cursor: { state: 'unavailable', reason: 'cursor_launch_failed', inlineCommentCount: 0, reviewerLogin: null, supersedesCopilot: true },
    threads: [],
  });
  assert.equal(report.readyForTriage, true);
  assert.equal(report.cursorUnavailable, true);
  assert.equal(report.mergeReady, false);
  assert.match(report.warnings[0], /cursor_launch_failed/);
});

test('readReviewThreadPage throws on GraphQL errors instead of returning zero threads', () => {
  assert.throws(
    () => readReviewThreadPage({ errors: [{ message: 'Resource not accessible' }] }, 7),
    /review threads query failed: Resource not accessible/
  );
  assert.throws(() => readReviewThreadPage({ data: { repository: { pullRequest: null } } }, 7), /no reviewThreads/);
});

test('readReviewThreadPage returns nodes and the next cursor', () => {
  const page = (pageInfo) => ({ data: { repository: { pullRequest: { reviewThreads: { pageInfo, nodes: [{ isResolved: false }] } } } } });
  assert.deepEqual(readReviewThreadPage(page({ hasNextPage: true, endCursor: 'c1' }), 7), { nodes: [{ isResolved: false }], nextCursor: 'c1' });
  assert.equal(readReviewThreadPage(page({ hasNextPage: false, endCursor: 'c1' }), 7).nextCursor, null);
});

test('parsePrRef accepts url, slug, and number', () => {
  assert.deepEqual(parsePrRef('https://github.com/o/r/pull/12'), {
    owner: 'o',
    repo: 'r',
    number: 12,
  });
  assert.deepEqual(parsePrRef('o/r#12'), { owner: 'o', repo: 'r', number: 12 });
  assert.deepEqual(parsePrRef('12', 'o', 'r'), { owner: 'o', repo: 'r', number: 12 });
});
