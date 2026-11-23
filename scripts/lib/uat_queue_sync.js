'use strict';

const {
  fetchIssue,
  rest,
  upsertMarkerComment,
} = require('../../.github/scripts/github-project-lib');
const { resolveRepository } = require('./execute_plan_project');
const {
  COORDINATION_ISSUE_NUMBER,
  STATE_MARKER,
} = require('./uat_queue_constants');
const {
  UatQueueError,
  createEmptyState,
  normalizeState,
  parseStateFromCommentBody,
  renderStateCommentBody,
} = require('./uat_queue_lib');

/** Bound for re-read / reapply when another writer changes the marker mid-update. */
const MAX_UAT_QUEUE_WRITE_ATTEMPTS = 5;

function resolveCoordinationIssue(issueOverride) {
  const issueNumber = Number(issueOverride || COORDINATION_ISSUE_NUMBER);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    return null;
  }
  return issueNumber;
}

function getGithubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

async function fetchIssueComments(owner, repo, issueNumber, token) {
  const comments = [];
  let page = 1;
  while (true) {
    const batch = await rest(
      'GET',
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token
    );
    if (!batch.length) {
      break;
    }
    comments.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }
  return comments;
}

async function loadStateFromIssue(issueNumber, token) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  if (!authToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to load uat queue state');
  }

  const comments = await fetchIssueComments(owner, repo, issueNumber, authToken);

  const markerComment = [...comments]
    .reverse()
    .find((comment) => comment.body?.includes(STATE_MARKER));

  if (!markerComment) {
    return {
      state: createEmptyState(),
      issueNumber,
      commentId: null,
      commentUpdatedAt: null,
    };
  }

  return {
    state: parseStateFromCommentBody(markerComment.body),
    issueNumber,
    commentId: markerComment.id,
    commentUpdatedAt: markerComment.updated_at || markerComment.created_at || null,
  };
}

function fingerprintState(state) {
  const normalized = normalizeState(state);
  normalized.updated_at = null;
  return JSON.stringify(normalized);
}

function revisionOf(loaded) {
  const commentId = loaded.commentId == null ? 'none' : String(loaded.commentId);
  const updatedAt = loaded.commentUpdatedAt == null ? 'none' : String(loaded.commentUpdatedAt);
  return `${commentId}:${updatedAt}:${fingerprintState(loaded.state)}`;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(normalizeState(state)));
}

/**
 * Load the marker, apply `mutate`, and save. If the marker changes between the
 * read and the save, discard that attempt and reapply `mutate` on the new
 * snapshot. Stops after `maxAttempts` when the store never converges.
 *
 * GitHub issue comments have no conditional PATCH. A writer can still lose an
 * update that lands after its last read and before its PATCH.
 *
 * `mutate` receives a clone and returns an object. Include `state` when the
 * result lives on a different object; in-place edits of the clone are kept.
 * A `created: true` result from any attempt is preserved on the return value.
 */
async function commitStateMutation({
  issueNumber,
  token = null,
  mutate,
  maxAttempts = MAX_UAT_QUEUE_WRITE_ATTEMPTS,
  loadState = loadStateFromIssue,
  saveState = saveStateToIssue,
} = {}) {
  if (typeof mutate !== 'function') {
    throw new UatQueueError('commitStateMutation requires mutate');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new UatQueueError('maxAttempts must be a positive integer');
  }

  let createdOnAnyAttempt = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const loaded = await loadState(issueNumber, token);
    const baseline = revisionOf(loaded);
    const working = cloneState(loaded.state);
    const returned = await mutate(working);
    const outcome = returned && typeof returned === 'object' ? returned : {};
    if (outcome.created === true) {
      createdOnAnyAttempt = true;
    }
    const nextState = outcome.state || working;
    const fresh = await loadState(issueNumber, token);
    if (revisionOf(fresh) !== baseline) {
      continue;
    }

    // A skipped mutation must not create a marker or rewrite the ledger.
    if (outcome.skipped === true) {
      return finishCommit(outcome, fresh, false, attempt, issueNumber, createdOnAnyAttempt);
    }

    const unchanged = fingerprintState(fresh.state) === fingerprintState(nextState);
    if (fresh.commentId != null && unchanged) {
      return finishCommit(outcome, fresh, false, attempt, issueNumber, createdOnAnyAttempt);
    }

    await saveState(issueNumber, nextState, token);
    const confirmed = await loadState(issueNumber, token);
    if (fingerprintState(confirmed.state) === fingerprintState(nextState)) {
      return finishCommit(outcome, confirmed, true, attempt, issueNumber, createdOnAnyAttempt);
    }
  }

  throw new UatQueueError(
    `uat queue write did not converge after ${maxAttempts} attempts`,
    'uat_queue_write_conflict',
  );
}

function finishCommit(outcome, loaded, written, attempt, issueNumber, createdOnAnyAttempt) {
  const result = {
    ...outcome,
    state: loaded.state,
    written,
    attempts: attempt,
    commentId: loaded.commentId ?? null,
    issueNumber,
  };
  if (createdOnAnyAttempt) {
    result.created = true;
  }
  return result;
}

async function saveStateToIssue(issueNumber, state, token) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  if (!authToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to save uat queue state');
  }

  const body = renderStateCommentBody(state);
  const commentId = await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: STATE_MARKER,
    body,
    token: authToken,
  });

  return { issueNumber, commentId, updated_at: state.updated_at };
}

async function ensureCoordinationIssueExists(issueNumber, token) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  await fetchIssue(owner, repo, issueNumber, authToken);
}

module.exports = {
  MAX_UAT_QUEUE_WRITE_ATTEMPTS,
  commitStateMutation,
  ensureCoordinationIssueExists,
  fingerprintState,
  loadStateFromIssue,
  resolveCoordinationIssue,
  saveStateToIssue,
};
