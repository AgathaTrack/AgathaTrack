#!/usr/bin/env node
/**
 * Cross-agent UAT deploy queue runtime.
 *
 *   node scripts/uat_queue_runtime.js enqueue --merge <sha> --pr <n> [--ref context] [--issue N] [--write]
 *   node scripts/uat_queue_runtime.js status [--merge <sha> | --seq <n>]
 *   node scripts/uat_queue_runtime.js barrier-check [--branch <name>]
 *   node scripts/uat_queue_runtime.js acquire-watcher --holder <id> [--lease-minutes 90] [--issue N] [--write]
 *   node scripts/uat_queue_runtime.js release-watcher [--issue N] [--write]
 *   node scripts/uat_queue_runtime.js set-barrier --sha <sha> [--reason text] [--issue N] [--write]
 *   node scripts/uat_queue_runtime.js reconcile [--issue N] [--write]
 *   node scripts/uat_queue_runtime.js render-state [--issue N]
 *
 * Exit codes: 0 ok; 2 expected wait (watcher held); 1 error.
 */

'use strict';

// CLI only — before any GitHub fetch: sandbox egress needs NODE_USE_ENV_PROXY at process start.
if (require.main === module) {
  require('./lib/env_proxy_reexec').reexecWithEnvProxy();
}

const { execFileSync } = require('child_process');
const path = require('path');
const {
  COORDINATION_ISSUE_NUMBER,
  DEFAULT_WATCHER_LEASE_MINUTES,
} = require('./lib/uat_queue_constants');
const {
  UatQueueError,
  acquireWatcher,
  barrierCheck,
  clearPromoteHold,
  enqueueEntry,
  findEntryByMergeSha,
  headEntryNeedingAttention,
  isWatcherLeaseActive,
  markEntryRemedial,
  queueHeadHold,
  releaseWatcher,
  setBarrier,
  setPromoteHold,
} = require('./lib/uat_queue_lib');
const {
  commitStateMutation,
  loadStateFromIssue,
  resolveCoordinationIssue,
} = require('./lib/uat_queue_sync');

const REPO_ROOT = path.resolve(__dirname, '..');

function usage() {
  console.error(`Usage: node scripts/uat_queue_runtime.js <command> [options]

Commands:
  enqueue --merge <sha> --pr <n> [--ref context] [--issue N] [--write]
  status [--merge <sha> | --seq <n>] [--issue N]
  barrier-check [--branch <name>] [--issue N]
  queue-head-hold [--issue N]
  health-check [--issue N]
  acquire-watcher --holder <id> [--lease-minutes N] [--issue N] [--write]
  release-watcher [--issue N] [--write]
  set-barrier --sha <sha> [--reason text] [--issue N] [--write]
  set-promote-hold [--reason text] [--issue N] [--write]
  clear-promote-hold [--issue N] [--write]
  mark-remedial [--merge <sha> | --pr <n>] [--issue N] [--write]
  reconcile [--issue N] [--write]
  render-state [--issue N]

Default coordination issue: UAT_COORDINATION_ISSUE env or ${COORDINATION_ISSUE_NUMBER} (0 = unset; pass --issue).
`);
  process.exit(1);
}

function fail(msg, code = 1) {
  console.error(`uat_queue_runtime: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function requireStringFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new UatQueueError(`--${name} requires a value`);
  }
  return value.trim();
}

function requirePositiveIntFlag(flags, name) {
  const raw = requireStringFlag(flags, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UatQueueError(`--${name} must be a positive integer`);
  }
  return value;
}

function optionalStringFlag(flags, name) {
  if (flags[name] === undefined) {
    return null;
  }
  return requireStringFlag(flags, name);
}

function optionalPositiveIntFlag(flags, name, defaultValue) {
  if (flags[name] === undefined) {
    return defaultValue;
  }
  if (flags[name] === true) {
    throw new UatQueueError(`--${name} requires a value`);
  }
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < 1) {
    throw new UatQueueError(`--${name} must be a positive integer`);
  }
  return value;
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function gitRevParse(ref) {
  return execFileSync('git', ['rev-parse', ref], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function gitIsAncestor(ancestor, descendant) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function resolveBranchTip(branchName) {
  const branch = branchName || gitRevParse('--abbrev-ref HEAD');
  if (branch === 'HEAD') {
    return gitRevParse('HEAD');
  }
  try {
    execFileSync('git', ['fetch', 'origin', 'main', '--quiet'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  } catch {
    // offline / no remote
  }
  return gitRevParse(branch);
}

function requireIssueNumber(flags) {
  const issueNumber = resolveCoordinationIssue(flags.issue);
  if (!issueNumber) {
    throw new UatQueueError(
      'coordination issue not configured — set UAT_COORDINATION_ISSUE or pass --issue'
    );
  }
  return issueNumber;
}

async function loadIssueState(flags) {
  const issueNumber = requireIssueNumber(flags);
  return loadStateFromIssue(issueNumber);
}

async function commitCommand(flags, mutate) {
  const issueNumber = requireIssueNumber(flags);
  if (!flags.write) {
    const loaded = await loadStateFromIssue(issueNumber);
    const outcome = (await mutate(loaded.state)) || {};
    return {
      issueNumber,
      state: outcome.state || loaded.state,
      outcome,
      saveMeta: { saved: false },
    };
  }
  const outcome = await commitStateMutation({ issueNumber, mutate });
  return {
    issueNumber,
    state: outcome.state,
    outcome,
    saveMeta: {
      saved: outcome.written === true,
      issueNumber: outcome.issueNumber,
      commentId: outcome.commentId,
      updated_at: outcome.state ? outcome.state.updated_at : null,
    },
  };
}

async function runCommand(cmd, flags) {
  switch (cmd) {
    case 'enqueue': {
      const mergeSha = requireStringFlag(flags, 'merge');
      const prNumber = requirePositiveIntFlag(flags, 'pr');
      const enqueuedBy = optionalStringFlag(flags, 'ref');
      const uatTag = optionalStringFlag(flags, 'tag');
      const committed = await commitCommand(flags, (state) => enqueueEntry(state, {
        mergeSha,
        prNumber,
        enqueuedBy,
        uatTag,
      }));
      printJson({
        command: 'enqueue',
        entry: committed.outcome.entry,
        created: committed.outcome.created,
        ...committed.saveMeta,
      });
      return;
    }

    case 'status': {
      const { state } = await loadIssueState(flags);
      let entry = null;
      if (flags.merge) {
        entry = findEntryByMergeSha(state, flags.merge);
      } else if (flags.seq) {
        entry = state.entries.find((e) => e.seq === Number(flags.seq)) || null;
      } else {
        entry = headEntryNeedingAttention(state);
      }
      printJson({
        command: 'status',
        main_barrier_sha: state.main_barrier_sha,
        active_watcher: state.active_watcher,
        watcher_lease_active: isWatcherLeaseActive(state),
        entry,
        entries: state.entries,
      });
      return;
    }

    case 'barrier-check': {
      const issueNumber = resolveCoordinationIssue(flags.issue);
      let barrierSha = flags.barrier || null;
      if (!barrierSha && issueNumber) {
        const loaded = await loadStateFromIssue(issueNumber);
        barrierSha = loaded.state.main_barrier_sha;
      }
      const branchTipSha = resolveBranchTip(flags.branch);
      const result = barrierCheck({
        barrierSha,
        branchTipSha,
        isAncestor: gitIsAncestor,
      });
      printJson({ command: 'barrier-check', ...result });
      if (result.needs_rebase) {
        process.exit(2);
      }
      return;
    }

    case 'queue-head-hold': {
      const { state } = await loadIssueState(flags);
      const result = queueHeadHold(state);
      printJson({ command: 'queue-head-hold', ...result });
      if (result.hold) {
        process.exit(2);
      }
      return;
    }

    case 'health-check': {
      const issueNumber = resolveCoordinationIssue(flags.issue);
      if (!issueNumber) {
        printJson({
          command: 'health-check',
          ok: false,
          reason: 'coordination_issue_not_configured',
        });
        process.exit(1);
      }
      try {
        const loaded = await loadStateFromIssue(issueNumber);
        printJson({
          command: 'health-check',
          ok: true,
          issue_number: issueNumber,
          entries: loaded.state.entries.length,
          watcher_lease_active: isWatcherLeaseActive(loaded.state),
        });
      } catch (e) {
        printJson({
          command: 'health-check',
          ok: false,
          issue_number: issueNumber,
          reason: e.message,
        });
        process.exit(1);
      }
      return;
    }

    case 'acquire-watcher': {
      const holder = requireStringFlag(flags, 'holder');
      const leaseMinutes = optionalPositiveIntFlag(
        flags,
        'lease-minutes',
        DEFAULT_WATCHER_LEASE_MINUTES
      );
      const committed = await commitCommand(flags, (state) => {
        const head = headEntryNeedingAttention(state);
        return acquireWatcher(state, { holder, leaseMinutes, watchingSeq: head?.seq });
      });
      const result = committed.outcome;
      if (!result.acquired) {
        printJson({ command: 'acquire-watcher', acquired: false, ...result });
        process.exit(2);
      }
      printJson({
        command: 'acquire-watcher',
        acquired: true,
        watcher: result.watcher,
        ...committed.saveMeta,
      });
      return;
    }

    case 'release-watcher': {
      const committed = await commitCommand(flags, (state) => {
        releaseWatcher(state);
        return { state };
      });
      printJson({ command: 'release-watcher', ...committed.saveMeta });
      return;
    }

    case 'set-barrier': {
      const sha = requireStringFlag(flags, 'sha');
      const reason = optionalStringFlag(flags, 'reason');
      const committed = await commitCommand(flags, (state) => {
        setBarrier(state, { sha, reason });
        return { state };
      });
      printJson({
        command: 'set-barrier',
        main_barrier_sha: committed.state.main_barrier_sha,
        ...committed.saveMeta,
      });
      return;
    }

    case 'set-promote-hold': {
      const reason = optionalStringFlag(flags, 'reason');
      const committed = await commitCommand(flags, (state) => {
        setPromoteHold(state, { reason });
        return { state };
      });
      printJson({
        command: 'set-promote-hold',
        promote_hold: committed.state.promote_hold,
        promote_hold_reason: committed.state.promote_hold_reason,
        ...committed.saveMeta,
      });
      return;
    }

    case 'clear-promote-hold': {
      const committed = await commitCommand(flags, (state) => {
        clearPromoteHold(state);
        return { state };
      });
      printJson({ command: 'clear-promote-hold', promote_hold: false, ...committed.saveMeta });
      return;
    }

    case 'mark-remedial': {
      const mergeSha = optionalStringFlag(flags, 'merge');
      const prNumber = flags.pr ? requirePositiveIntFlag(flags, 'pr') : null;
      const committed = await commitCommand(flags, (state) => markEntryRemedial(state, {
        mergeSha,
        prNumber,
      }));
      printJson({
        command: 'mark-remedial',
        entry: committed.outcome.entry,
        ...committed.saveMeta,
      });
      return;
    }

    case 'reconcile': {
      // Phase 1: load + normalize only; Actions notify updates deploy results.
      const committed = await commitCommand(flags, (state) => ({ state }));
      printJson({
        command: 'reconcile',
        entries: committed.state.entries.length,
        head: headEntryNeedingAttention(committed.state),
        watcher_lease_active: isWatcherLeaseActive(committed.state),
        ...committed.saveMeta,
      });
      return;
    }

    case 'render-state': {
      const { state } = await loadIssueState(flags);
      printJson(state);
      return;
    }

    default:
      usage();
  }
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd) usage();

  try {
    await runCommand(cmd, flags);
  } catch (e) {
    if (e instanceof UatQueueError) {
      fail(e.message);
    }
    fail(e.message);
  }
}

if (require.main === module) {
  main();
}
