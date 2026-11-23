'use strict';

const {
  COORDINATION_ISSUE_NUMBER,
} = require('./uat_queue_constants');
const {
  applyDeployResult,
  enqueueEntry,
  entryHasState,
  findActiveEntryByPr,
  hasActiveEntryForSha,
  parseUatTag,
} = require('./uat_queue_lib');
const {
  resolveCoordinationIssue,
  updateQueueState,
} = require('./uat_queue_sync');

/**
 * Ensure a ledger entry exists for the UAT tag's PR inside `state` (mutates it).
 * Pure apart from the optional tag-SHA lookup, so callers can run it inside one
 * updateQueueState mutation.
 */
async function ensureEntryInState(state, { deployRef, mergeSha, owner, repo, token, enqueuedBy }) {
  const parsed = parseUatTag(deployRef);
  if (!parsed) {
    return { skipped: true, reason: 'invalid_deploy_ref' };
  }

  const existing = findActiveEntryByPr(state, parsed.prNumber);
  if (existing) {
    return { skipped: false, entry: existing, created: false };
  }

  let sha = mergeSha || null;
  if (!sha && owner && repo && token) {
    try {
      const { tagCommitSha } = require('./uat_deploy_run_resolve');
      sha = await tagCommitSha(owner, repo, deployRef, token);
    } catch {
      sha = null;
    }
  }
  if (!sha) {
    return { skipped: true, reason: 'merge_sha_unavailable' };
  }

  const result = enqueueEntry(state, {
    mergeSha: sha,
    prNumber: parsed.prNumber,
    enqueuedBy: enqueuedBy || `pr-${parsed.prNumber}`,
    uatTag: deployRef,
  });
  return { skipped: false, entry: result.entry, created: result.created };
}

/**
 * updateQueueState mutation that enqueues one merge. Idempotent on mergeSha: a
 * duplicate event returns the existing entry with created: false and no write.
 * @param {{ mergeSha: string, prNumber: number, enqueuedBy?: string|null, uatTag?: string }} input
 */
function enqueueMutation(input) {
  return (state) => {
    const result = enqueueEntry(state, input);
    if (!result.created) {
      return { result, verify: null };
    }
    const sha = result.entry.merge_sha;
    return { result, verify: (loaded) => hasActiveEntryForSha(loaded.state, sha) };
  };
}

/**
 * Ensure a ledger entry exists for a UAT tag / PR before deploy sync.
 * Used when merge-handler skipped enqueue (no linked issue) or ledger drifted.
 */
async function ensureQueueEntryForDeployRef({
  deployRef,
  mergeSha,
  owner,
  repo,
  issueNumber = COORDINATION_ISSUE_NUMBER,
  token,
  enqueuedBy,
  write = true,
}) {
  if (!parseUatTag(deployRef)) {
    return { skipped: true, reason: 'invalid_deploy_ref' };
  }

  const coordIssue = resolveCoordinationIssue(issueNumber);
  if (!coordIssue) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const outcome = await updateQueueState(
    coordIssue,
    async (state) => {
      const ensured = await ensureEntryInState(state, {
        deployRef,
        mergeSha,
        owner,
        repo,
        token,
        enqueuedBy,
      });
      if (ensured.skipped || !ensured.created) {
        return { result: ensured, verify: null };
      }
      const sha = ensured.entry.merge_sha;
      return { result: ensured, verify: (loaded) => hasActiveEntryForSha(loaded.state, sha) };
    },
    { token, write },
  );

  const ensured = outcome.result;
  if (ensured.skipped) {
    return { ...ensured, issueNumber: coordIssue };
  }
  return {
    skipped: false,
    entry: ensured.entry,
    created: ensured.created,
    issueNumber: coordIssue,
    state: outcome.state,
  };
}

async function syncEnqueueAfterMerge({
  mergeSha,
  prNumber,
  enqueuedBy,
  issueNumber = COORDINATION_ISSUE_NUMBER,
  token,
}) {
  const coordIssue = resolveCoordinationIssue(issueNumber);
  if (!coordIssue) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const outcome = await updateQueueState(
    coordIssue,
    enqueueMutation({
      mergeSha,
      prNumber,
      enqueuedBy: enqueuedBy || `pr-${prNumber}`,
    }),
    { token },
  );
  return {
    skipped: false,
    entry: outcome.result.entry,
    created: outcome.result.created,
    issueNumber: coordIssue,
  };
}

async function syncDeployResult({
  deployRef,
  conclusion,
  deployRunId,
  gateSummaryRef,
  gateFailureClass,
  issueNumber = COORDINATION_ISSUE_NUMBER,
  token,
  write = true,
  owner = null,
  repo = null,
  mergeSha = null,
}) {
  const coordIssue = resolveCoordinationIssue(issueNumber);
  if (!coordIssue) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const parsed = parseUatTag(deployRef);
  const outcome = await updateQueueState(
    coordIssue,
    async (state) => {
      if (parsed && !findActiveEntryByPr(state, parsed.prNumber)) {
        await ensureEntryInState(state, {
          deployRef,
          mergeSha,
          owner,
          repo,
          token,
          enqueuedBy: `pr-${parsed.prNumber}`,
        });
      }

      const result = applyDeployResult(state, {
        deployRef,
        conclusion,
        deployRunId,
        gateSummaryRef,
        gateFailureClass,
      });
      if (result.skipped) {
        return { result, verify: null };
      }
      const { seq, state: entryState, result: entryResult } = result.entry;
      return {
        result,
        verify: (loaded) =>
          entryHasState(loaded.state, seq, { state: entryState, result: entryResult }),
      };
    },
    { token, write },
  );

  const applied = outcome.result;
  if (applied.skipped) {
    return { skipped: true, reason: applied.reason, issueNumber: coordIssue };
  }
  return {
    skipped: false,
    entry: applied.entry,
    issueNumber: coordIssue,
    conclusion,
    state: outcome.state,
    backfilled: Boolean(parsed && mergeSha),
  };
}

module.exports = {
  enqueueMutation,
  ensureEntryInState,
  ensureQueueEntryForDeployRef,
  syncDeployResult,
  syncEnqueueAfterMerge,
};
