#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CURSOR_REVIEW_MARKER,
  STATES,
  assessCursorReviewStatus,
  buildCursorReviewPrompt,
  buildStateCommentBody,
  copilotRequested,
  copilotStarted,
  parseBotAuthors,
  parseStateMarker,
  shouldHandlePr,
} = require('./pr_review_request_lib');

const COPILOT_BOT = 'copilot-pull-request-reviewer[bot]';

function pull(overrides = {}) {
  return {
    state: 'open',
    draft: false,
    user: { login: 'pawpet-bot' },
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    head: { ref: 'cursor/x', sha: 'abc', repo: { full_name: 'o/r' } },
    requested_reviewers: [],
    ...overrides,
  };
}

function markerComment(state, login = 'github-actions[bot]', id = 1) {
  return { id, user: { login }, body: buildStateCommentBody(state) };
}

test('parseBotAuthors falls back to the default agent accounts', () => {
  assert.deepEqual(parseBotAuthors(''), ['pawpet-bot', 'pawpet-claude']);
  assert.deepEqual(parseBotAuthors(' a , b ,'), ['a', 'b']);
});

test('shouldHandlePr only accepts open, ready, same-repo agent PRs to main', () => {
  assert.deepEqual(shouldHandlePr(pull()), { ok: true, reason: 'agent_pr' });
  assert.equal(shouldHandlePr(null).reason, 'pr_not_found');
  assert.equal(shouldHandlePr(pull({ state: 'closed' })).reason, 'pr_not_open');
  assert.equal(shouldHandlePr(pull({ draft: true })).reason, 'draft');
  assert.equal(shouldHandlePr(pull({ base: { ref: 'cursor/integration', repo: { full_name: 'o/r' } } })).reason, 'base_not_main');
  assert.equal(shouldHandlePr(pull({ head: { ref: 'x', repo: { full_name: 'fork/r' } } })).reason, 'fork');
  assert.equal(shouldHandlePr(pull({ user: { login: 'KanopeeKa' } })).reason, 'author_not_agent');
});

test('copilotStarted detects the work-started event, a review, or an inline comment', () => {
  assert.equal(copilotStarted({}), false);
  assert.equal(copilotStarted({ events: [{ event: 'review_requested' }] }), false);
  assert.equal(copilotStarted({ events: [{ event: 'copilot_work_started' }] }), true);
  assert.equal(copilotStarted({ reviews: [{ user: { login: COPILOT_BOT } }] }), true);
  assert.equal(copilotStarted({ reviewComments: [{ user: { login: COPILOT_BOT } }] }), true);
  assert.equal(copilotStarted({ reviews: [{ user: { login: 'pawpet-bot' } }] }), false);
});

test('copilotRequested reads requested_reviewers', () => {
  assert.equal(copilotRequested(pull({ requested_reviewers: [{ login: 'Copilot' }] })), true);
  assert.equal(copilotRequested(pull()), false);
});

test('parseStateMarker trusts only github-actions[bot] and returns the latest marker', () => {
  const comments = [
    markerComment({ state: STATES.REQUESTED }, 'github-actions[bot]', 10),
    markerComment({ state: STATES.COPILOT }, 'pawpet-bot', 11),
    { id: 12, user: { login: 'github-actions[bot]' }, body: '<!-- pr-review-request: {broken -->' },
  ];
  assert.deepEqual(parseStateMarker(comments), { commentId: 10, state: { state: STATES.REQUESTED } });
  assert.deepEqual(parseStateMarker([]), { commentId: null, state: null });
});

test('buildCursorReviewPrompt is review-only and pins the head commit and marker', () => {
  const prompt = buildCursorReviewPrompt({ repoSlug: 'o/r', prNumber: 7, prUrl: 'https://github.com/o/r/pull/7', headSha: 'deadbeef' });
  assert.match(prompt, /REVIEW-ONLY/);
  assert.match(prompt, /Do not edit, create or delete files in the repository, commit, push/);
  assert.match(prompt, /\/tmp\/cursor-review.json/);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /"commit_id":"deadbeef"/);
  assert.match(prompt, /"event":"COMMENT"/);
  assert.ok(prompt.includes(CURSOR_REVIEW_MARKER));
});

test('assessCursorReviewStatus follows the marker until a Cursor review lands', () => {
  const at = (state) => assessCursorReviewStatus({ issueComments: [markerComment({ state })] });
  assert.equal(assessCursorReviewStatus({}).state, 'skipped');
  assert.equal(at(STATES.REQUESTED).state, 'pending');
  assert.equal(at(STATES.CURSOR_LAUNCHED).reason, 'review_running');
  assert.equal(at(STATES.COPILOT).state, 'skipped');
  assert.equal(at(STATES.UNAVAILABLE).state, 'unavailable');
  assert.equal(at(STATES.UNAVAILABLE).supersedesCopilot, true);
  assert.equal(at(STATES.REQUESTED).supersedesCopilot, false);

  const done = assessCursorReviewStatus({
    issueComments: [markerComment({ state: STATES.CURSOR_LAUNCHED, launched_at: '2026-11-16T10:00:00Z' })],
    reviews: [{ user: { login: 'pawpet-bot' }, submitted_at: '2026-11-16T10:05:00Z', body: `summary\n\n${CURSOR_REVIEW_MARKER}` }],
    reviewComments: [{ user: { login: 'pawpet-bot' }, body: `bug\n\n${CURSOR_REVIEW_MARKER}` }, { user: { login: 'pawpet-bot' }, body: 'reply' }],
  });
  assert.deepEqual(done, {
    state: 'complete',
    reason: 'review_submitted',
    inlineCommentCount: 1,
    reviewerLogin: 'pawpet-bot',
    supersedesCopilot: true,
  });
});

test('assessCursorReviewStatus only counts the launched identity, after launch', () => {
  const marker = markerComment({ state: STATES.CURSOR_LAUNCHED, launched_at: '2026-11-16T10:00:00Z', reviewer_login: 'agent-bot' });
  const review = (login, submittedAt) => ({ user: { login }, submitted_at: submittedAt, body: `quoted ${CURSOR_REVIEW_MARKER}` });
  const status = (reviews) => assessCursorReviewStatus({ issueComments: [marker], reviews }).state;
  assert.equal(status([review('pawpet-claude', '2026-11-16T10:05:00Z')]), 'pending');
  assert.equal(status([review('agent-bot', '2026-11-16T09:55:00Z')]), 'pending');
  assert.equal(status([review('agent-bot', '2026-11-16T10:05:00Z')]), 'complete');
});

test('assessCursorReviewStatus ignores markers posted by the PR author', () => {
  const status = assessCursorReviewStatus({ issueComments: [markerComment({ state: STATES.COPILOT }, 'pawpet-bot')] });
  assert.equal(status.reason, 'not_requested');
});
