'use strict';

const {
  COORDINATION_ISSUE_NUMBER,
} = require('./uat_queue_constants');
const {
  applyDeployResult,
  enqueueEntry,
  findActiveEntryByPr,
  parseUatTag,
} = require('./uat_queue_lib');
const {
  commitStateMutation,
  loadStateFromIssue,
  resolveCoordinationIssue,
} = require('./uat_queue_sync');

function ensuredDeployEntry(state, { deployRef, mergeSha, enqueuedBy }) {
  const parsed = parseUatTag(deployRef);
  if (!parsed) {
    return { state, skipped: true, reason: 'invalid_deploy_ref' };
  }

  const existing = findActiveEntryByPr(state, parsed.prNumber);
  if (existing) {
    return { state, skipped: false, entry: existing, created: false };
  }
  if (!mergeSha) {
    return { state, skipped: true, reason: 'merge_sha_unavailable' };
  }

  const result = enqueueEntry(state, {
    mergeSha,
    prNumber: parsed.prNumber,
    enqueuedBy: enqueuedBy || `pr-${parsed.prNumber}`,
    uatTag: deployRef,
  });
  return { state: result.state, skipped: false, entry: result.entry, created: result.created };
}

async function resolveDeployMergeSha({ deployRef, mergeSha, owner, repo, token }) {
  if (mergeSha || !owner || !repo || !token) {
    return mergeSha || null;
  }
  try {
    const { tagCommitSha } = require('./uat_deploy_run_resolve');
    return await tagCommitSha(owner, repo, deployRef, token);
  } catch {
    return null;
  }
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
  loadState,
  saveState,
  maxAttempts,
}) {
  const parsed = parseUatTag(deployRef);
  if (!parsed) {
    return { skipped: true, reason: 'invalid_deploy_ref' };
  }

  const coordIssue = resolveCoordinationIssue(issueNumber);
  if (!coordIssue) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const sha = await resolveDeployMergeSha({ deployRef, mergeSha, owner, repo, token });
  const mutate = (state) => ensuredDeployEntry(state, {
    deployRef,
    mergeSha: sha,
    enqueuedBy: enqueuedBy || `pr-${parsed.prNumber}`,
  });

  if (!write) {
    const { state } = await loadStateFromIssue(coordIssue, token);
    const result = mutate(state);
    if (result.skipped) {
      return { skipped: true, reason: result.reason, issueNumber: coordIssue };
    }
    return {
      skipped: false,
      entry: result.entry,
      created: result.created,
      issueNumber: coordIssue,
      state: result.state,
    };
  }

  const outcome = await commitStateMutation({
    issueNumber: coordIssue,
    token,
    mutate,
    loadState,
    saveState,
    maxAttempts,
  });
  if (outcome.skipped) {
    return { skipped: true, reason: outcome.reason, issueNumber: coordIssue };
  }
  return {
    skipped: false,
    entry: outcome.entry,
    created: outcome.created,
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
  loadState,
  saveState,
  maxAttempts,
}) {
  const coordIssue = resolveCoordinationIssue(issueNumber);
  if (!coordIssue) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const outcome = await commitStateMutation({
    issueNumber: coordIssue,
    token,
    loadState,
    saveState,
    maxAttempts,
    mutate(state) {
      return enqueueEntry(state, {
        mergeSha,
        prNumber,
        enqueuedBy: enqueuedBy || `pr-${prNumber}`,
      });
    },
  });
  return {
    skipped: false,
    entry: outcome.entry,
    created: outcome.created,
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
  loadState,
  saveState,
  maxAttempts,
}) {
  const coordIssue = resolveCoordinationIssue(issueNumber);
  if (!coordIssue) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const parsed = parseUatTag(deployRef);
  const sha = await resolveDeployMergeSha({ deployRef, mergeSha, owner, repo, token });
  const mutate = (state) => {
    let working = state;
    if (parsed && !findActiveEntryByPr(working, parsed.prNumber)) {
      const ensured = ensuredDeployEntry(working, {
        deployRef,
        mergeSha: sha,
        enqueuedBy: `pr-${parsed.prNumber}`,
      });
      if (!ensured.skipped && ensured.state) {
        working = ensured.state;
      }
    }
    return applyDeployResult(working, {
      deployRef,
      conclusion,
      deployRunId,
      gateSummaryRef,
      gateFailureClass,
    });
  };

  const outcome = write
    ? await commitStateMutation({
      issueNumber: coordIssue,
      token,
      mutate,
      loadState,
      saveState,
      maxAttempts,
    })
    : mutate((await loadStateFromIssue(coordIssue, token)).state);

  if (outcome.skipped) {
    return { skipped: true, reason: outcome.reason, issueNumber: coordIssue };
  }
  return {
    skipped: false,
    entry: outcome.entry,
    issueNumber: coordIssue,
    conclusion,
    state: outcome.state,
    backfilled: Boolean(parsed && mergeSha),
  };
}

module.exports = {
  ensureQueueEntryForDeployRef,
  syncDeployResult,
  syncEnqueueAfterMerge,
};
