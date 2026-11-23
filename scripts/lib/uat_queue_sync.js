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
  parseStateFromCommentBody,
  renderStateCommentBody,
} = require('./uat_queue_lib');

const DEFAULT_UPDATE_ATTEMPTS = 3;

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
    return { state: createEmptyState(), issueNumber, commentId: null };
  }

  return {
    state: parseStateFromCommentBody(markerComment.body),
    issueNumber,
    commentId: markerComment.id,
  };
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

/**
 * Read-modify-write the marker comment, then verify the mutation's effect landed.
 *
 * GitHub offers no conditional PATCH for issue comments, so two writers can load the
 * same state and the later save drops the earlier one. After each save this re-reads
 * the marker; if the effect is missing it reloads and reapplies `mutate` to the fresh
 * state. Bounded: throws once `attempts` writes have not converged. The window between
 * a read-back and another writer's PATCH is not closed (see uat-coordinator-plan.md).
 *
 * @param {number} issueNumber
 * @param {(state: object, loaded: object) => ({ result?: any, verify?: (loaded: object) => boolean }) | Promise<object>} mutate
 *   Mutates `state` in place. Return `verify` only when a write is needed; omit it for a no-op.
 *   `verify` receives a freshly loaded `{ state, commentId }` and returns true when the effect is present.
 * @param {{ token?: string, attempts?: number, write?: boolean, store?: { load: Function, save: Function } }} [options]
 *   `write: false` runs the mutation without saving (dry run). `store` replaces load/save (tests).
 * @returns {Promise<{ result: any, state: object, written: boolean, attempts: number, commentId: number|null, save: object|null }>}
 */
async function updateQueueState(issueNumber, mutate, options = {}) {
  const {
    token,
    attempts = DEFAULT_UPDATE_ATTEMPTS,
    write = true,
    store = { load: loadStateFromIssue, save: saveStateToIssue },
  } = options;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new UatQueueError('updateQueueState attempts must be a positive integer');
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const loaded = await store.load(issueNumber, token);
    const step = (await mutate(loaded.state, loaded)) || {};
    if (!step.verify || !write) {
      return {
        result: step.result,
        state: loaded.state,
        written: false,
        attempts: attempt,
        commentId: loaded.commentId,
        save: null,
      };
    }

    const save = await store.save(issueNumber, loaded.state, token);
    const reloaded = await store.load(issueNumber, token);
    if (step.verify(reloaded)) {
      return {
        result: step.result,
        state: reloaded.state,
        written: true,
        attempts: attempt,
        commentId: reloaded.commentId,
        save,
      };
    }
  }

  throw new UatQueueError(
    `uat queue write did not converge after ${attempts} attempts on issue #${issueNumber}`,
    'uat_queue_write_conflict',
  );
}

module.exports = {
  ensureCoordinationIssueExists,
  loadStateFromIssue,
  resolveCoordinationIssue,
  saveStateToIssue,
  updateQueueState,
};
