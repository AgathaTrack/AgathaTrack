#!/usr/bin/env node
'use strict';

/**
 * Detect and recover a stuck UAT queue (stale watcher lease, failed head with
 * no coordinator). Used by uat-queue-health.yml and manual recovery.
 *
 * Exit 0 — healthy or recovery applied
 * Exit 2 — recovery recommended (prints JSON action for workflow_dispatch)
 */

const { execFileSync } = require('child_process');
const path = require('path');
const { rest } = require('../../.github/scripts/github-project-lib');
const {
  headEntryNeedingAttention,
  isWatcherLeaseActive,
  pruneExpiredWatcher,
  queueHeadHold,
  releaseWatcher,
} = require('../lib/uat_queue_lib');
const {
  loadStateFromIssue,
  resolveCoordinationIssue,
  updateQueueState,
} = require('../lib/uat_queue_sync');

const REPO_ROOT = path.resolve(__dirname, '../..');

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

async function holderRunFinished(owner, repo, holder, token) {
  const match = String(holder || '').match(/^gha-(\d+)$/);
  if (!match) {
    return false;
  }
  try {
    const run = await rest('GET', `/repos/${owner}/${repo}/actions/runs/${match[1]}`, token);
    return run.status === 'completed';
  } catch {
    return false;
  }
}

async function recoverStaleWatcher(state, owner, repo, token) {
  const before = state.active_watcher;
  pruneExpiredWatcher(state);
  if (state.active_watcher && isWatcherLeaseActive(state)) {
    const finished = await holderRunFinished(owner, repo, state.active_watcher.holder, token);
    if (finished) {
      releaseWatcher(state);
    }
  }
  return {
    changed: JSON.stringify(before) !== JSON.stringify(state.active_watcher),
    before,
    after: state.active_watcher,
  };
}

/**
 * updateQueueState mutation for the stale-watcher release. Re-runs the recovery on a
 * fresh load and verifies the lease it computed is the one stored.
 */
function watcherRecoveryMutation(owner, repo, token) {
  return async (state) => {
    const recovery = await recoverStaleWatcher(state, owner, repo, token);
    if (!recovery.changed) {
      return { result: recovery, verify: null };
    }
    const expected = JSON.stringify(recovery.after ?? null);
    return {
      result: recovery,
      verify: (loaded) => JSON.stringify(loaded.state.active_watcher ?? null) === expected,
    };
  };
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const write = process.env.WRITE_LEDGER === 'true';
  const dispatchRecovery = process.env.DISPATCH_RECOVERY === 'true';

  if (!token || !repository) {
    throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
  }

  const coordinationIssue = resolveCoordinationIssue(process.env.UAT_COORDINATION_ISSUE);
  if (!coordinationIssue) {
    printJson({ ok: true, reason: 'coordination_issue_not_configured' });
    return;
  }

  const [owner, repo] = repository.split('/');
  const { state, issueNumber } = await loadStateFromIssue(coordinationIssue, token);
  const watcherRecovery = await recoverStaleWatcher(state, owner, repo, token);

  let saved = false;
  let current = state;
  if (write && watcherRecovery.changed) {
    const outcome = await updateQueueState(
      issueNumber,
      watcherRecoveryMutation(owner, repo, token),
      { token },
    );
    saved = outcome.written;
    current = outcome.state;
  }

  // Decide from the converged state: another writer may have changed the lease or head.
  const hold = queueHeadHold(current);
  const head = headEntryNeedingAttention(current);
  const needsCoordinator =
    head
    && ['failed', 'remedial'].includes(head.state)
    && head.deploy_run_id
    && !isWatcherLeaseActive(current);

  const result = {
    ok: !hold.hold,
    issue_number: issueNumber,
    watcher_recovery: watcherRecovery,
    queue_hold: hold,
    head_entry: head,
    needs_coordinator_dispatch: needsCoordinator,
    saved,
  };

  if (needsCoordinator && dispatchRecovery) {
    execFileSync(
      'gh',
      [
        'workflow',
        'run',
        'uat-coordinator-dispatch.yml',
        '--ref',
        'main',
        '-f',
        `workflow_run_id=${head.deploy_run_id}`,
        '-f',
        'force=true',
      ],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, GH_TOKEN: token },
      },
    );
    result.dispatched_coordinator = true;
    result.dispatch_run_id = head.deploy_run_id;
  }

  printJson(result);

  if (needsCoordinator && !dispatchRecovery) {
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  recoverStaleWatcher,
  holderRunFinished,
};
