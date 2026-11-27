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
 * `created` is the value from the attempt that landed. An earlier attempt that
 * only tried to insert does not override a later `created: false`.
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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const loaded = await loadState(issueNumber, token);
    const baseline = revisionOf(loaded);
    const working = cloneState(loaded.state);
    const returned = await mutate(working);
    const outcome = returned && typeof returned === 'object' ? returned : {};
    const nextState = outcome.state || working;
    const fresh = await loadState(issueNumber, token);
    if (revisionOf(fresh) !== baseline) {
      continue;
    }

    // A skipped mutation must not create a marker or rewrite the ledger.
    if (outcome.skipped === true) {
      return finishCommit(outcome, fresh, false, attempt, issueNumber);
    }

    const unchanged = fingerprintState(fresh.state) === fingerprintState(nextState);
    if (fresh.commentId != null && unchanged) {
      return finishCommit(outcome, fresh, false, attempt, issueNumber);
    }

    // Patch the comment this attempt read. upsertMarkerComment edits the
    // oldest marker, while load reads the newest, so a duplicate pair would
    // never converge.
    await saveState(issueNumber, nextState, token, fresh.commentId ?? null);
    const confirmed = await loadState(issueNumber, token);
    if (fingerprintState(confirmed.state) === fingerprintState(nextState)) {
      return finishCommit(outcome, confirmed, true, attempt, issueNumber);
    }
  }

  throw new UatQueueError(
    `uat queue write did not converge after ${maxAttempts} attempts`,
    'uat_queue_write_conflict',
  );
}

function finishCommit(outcome, loaded, written, attempt, issueNumber) {
  return {
    ...outcome,
    state: loaded.state,
    written,
    attempts: attempt,
    commentId: loaded.commentId ?? null,
    issueNumber,
  };
}

async function saveStateToIssue(issueNumber, state, token, commentId = null) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  if (!authToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to save uat queue state');
  }

  const body = renderStateCommentBody(state);
  let writtenId = commentId;
  if (writtenId) {
    await rest(
      'PATCH',
      `/repos/${owner}/${repo}/issues/comments/${writtenId}`,
      authToken,
      { body },
    );
    await removeOtherMarkerComments(owner, repo, issueNumber, authToken, writtenId);
  } else {
    writtenId = await upsertMarkerComment({
      owner,
      repo,
      issueNumber,
      marker: STATE_MARKER,
      body,
      token: authToken,
    });
  }

  return { issueNumber, commentId: writtenId, updated_at: state.updated_at };
}

async function removeOtherMarkerComments(owner, repo, issueNumber, token, keepId) {
  let comments;
  try {
    comments = await fetchIssueComments(owner, repo, issueNumber, token);
  } catch {
    return;
  }
  const extras = comments.filter(
    (comment) => comment.id !== keepId && comment.body?.includes(STATE_MARKER),
  );
  for (const comment of extras) {
    try {
      await rest(
        'DELETE',
        `/repos/${owner}/${repo}/issues/comments/${comment.id}`,
        token,
      );
    } catch {
      // The newest marker is already updated. A leftover duplicate is removed
      // on a later save that again targets that newest comment.
    }
  }
}

/**
 * POST a new marker comment. Unlike `saveStateToIssue` (which upserts and so
 * PATCHes an existing marker), this never touches a marker that already exists.
 */
async function createStateMarkerComment(issueNumber, state, token = null) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  if (!authToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to create a uat queue marker');
  }
  const created = await rest(
    'POST',
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    authToken,
    { body: renderStateCommentBody(state) },
  );
  return created.id;
}

/** Every marker comment on the issue, oldest first: `{ id, body }`. */
async function listStateMarkerComments(issueNumber, token = null) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  if (!authToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to list uat queue markers');
  }
  const comments = await fetchIssueComments(owner, repo, issueNumber, authToken);
  return comments
    .filter((comment) => comment.body?.includes(STATE_MARKER))
    .map((comment) => ({ id: comment.id, body: comment.body }));
}

async function deleteStateMarkerComment(commentId, token = null) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  if (!authToken) {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required to delete a uat queue marker');
  }
  await rest('DELETE', `/repos/${owner}/${repo}/issues/comments/${commentId}`, authToken);
}

async function ensureCoordinationIssueExists(issueNumber, token) {
  const { owner, repo } = resolveRepository();
  const authToken = token || getGithubToken();
  await fetchIssue(owner, repo, issueNumber, authToken);
}

module.exports = {
  MAX_UAT_QUEUE_WRITE_ATTEMPTS,
  commitStateMutation,
  createStateMarkerComment,
  deleteStateMarkerComment,
  ensureCoordinationIssueExists,
  fingerprintState,
  listStateMarkerComments,
  loadStateFromIssue,
  resolveCoordinationIssue,
  saveStateToIssue,
};
