#!/usr/bin/env node
/**
 * Phase 1b bootstrap — create or verify the UAT coordination issue and ledger marker.
 *
 *   node scripts/uat_coordinator_bootstrap.js [--write] [--issue N] [--pin]
 *
 * Requires GH_TOKEN/GITHUB_TOKEN with issues:write. Setting UAT_COORDINATION_ISSUE
 * repo variable needs admin/actions:write — see docs/agent-efficiency/uat-coordinator-bootstrap.md.
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { rest } = require('../.github/scripts/github-project-lib');
const { resolveRepository } = require('./lib/execute_plan_project');
const { createEmptyState, parseStateFromCommentBody } = require('./lib/uat_queue_lib');
const {
  commitStateMutation,
  createStateMarkerComment,
  deleteStateMarkerComment,
  listStateMarkerComments,
  loadStateFromIssue,
  saveStateToIssue,
} = require('./lib/uat_queue_sync');

const COORDINATION_TITLE = '[uat-coordinator] UAT deploy queue';
const COORDINATION_LABELS = ['uat-coordinator', 'governance'];
const REPO_ROOT = path.resolve(__dirname, '..');

function getToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

function parseArgs(argv) {
  const flags = { write: false, pin: false, issue: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      flags.write = true;
    } else if (arg === '--pin') {
      flags.pin = true;
    } else if (arg === '--issue') {
      const raw = argv[i + 1];
      if (!raw || raw.startsWith('--')) {
        throw new Error('--issue requires a positive integer');
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--issue must be a positive integer');
      }
      flags.issue = value;
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/uat_coordinator_bootstrap.js [--write] [--issue N] [--pin]`);
      process.exit(0);
    }
  }
  return flags;
}

function ghJson(args) {
  const out = execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT });
  return out.trim() ? JSON.parse(out) : null;
}

async function ensureLabels(owner, repo, token) {
  for (const name of COORDINATION_LABELS) {
    try {
      await rest('GET', `/repos/${owner}/${repo}/labels/${encodeURIComponent(name)}`, token);
    } catch {
      await rest(
        'POST',
        `/repos/${owner}/${repo}/labels`,
        token,
        {
          name,
          color: name === 'uat-coordinator' ? '1D76DB' : 'BFD4F2',
          description:
            name === 'uat-coordinator'
              ? 'Pinned UAT deploy queue coordination issue'
              : 'Repo governance and process',
        },
      );
    }
  }
}

function findExistingIssue() {
  const issues = ghJson([
    'issue',
    'list',
    '--search',
    `${COORDINATION_TITLE} in:title`,
    '--state',
    'all',
    '--json',
    'number,title,state',
    '--limit',
    '10',
  ]);
  return (issues || []).find((issue) => issue.title === COORDINATION_TITLE) || null;
}

function renderIssueBody(issueNumber, owner, repo) {
  const n = issueNumber ? String(issueNumber) : '<n>';
  const base = `https://github.com/${owner}/${repo}/blob/main`;
  return `## UAT deploy queue

Cross-agent ledger for UAT promote/deploy coordination. Machine state lives in a marker comment (\`<!-- uat-queue-state:v1 -->\`).

**Plan:** [uat-coordinator-plan.md](${base}/docs/agent-efficiency/uat-coordinator-plan.md)  
**Runbook:** [uat-coordinator-bootstrap.md](${base}/docs/agent-efficiency/uat-coordinator-bootstrap.md)

### Bootstrap checklist

- [x] Pin this issue
- [ ] Set repo Actions variable \`UAT_COORDINATION_ISSUE=${n}\`
- [ ] \`node scripts/uat_queue_runtime.js health-check\` exits 0 (with env var set)
- [ ] Merge handler log shows \`UAT queue: enqueued\` (not \`skipped\`)

### Operator commands

\`\`\`bash
export UAT_COORDINATION_ISSUE=${n}
node scripts/uat_queue_runtime.js health-check
node scripts/uat_queue_runtime.js status
node scripts/uat_queue_runtime.js reconcile --write
\`\`\`

Do not edit the marker comment by hand.`;
}

async function createOrUpdateIssue(owner, repo, token, issueNumber, write) {
  const body = renderIssueBody(issueNumber, owner, repo);
  if (issueNumber) {
    if (write) {
      await rest('PATCH', `/repos/${owner}/${repo}/issues/${issueNumber}`, token, {
        title: COORDINATION_TITLE,
        body,
        state: 'open',
        labels: COORDINATION_LABELS,
      });
    }
    return issueNumber;
  }

  if (!write) {
    return null;
  }

  const created = await rest('POST', `/repos/${owner}/${repo}/issues`, token, {
    title: COORDINATION_TITLE,
    body,
    labels: COORDINATION_LABELS,
  });
  return created.number;
}

function pinIssue(issueNumber) {
  ghJson(['issue', 'pin', String(issueNumber)]);
}

function ledgerHasLiveContent(state) {
  return Boolean(
    (state.entries && state.entries.length > 0)
    || state.main_barrier_sha
    || state.promote_hold
    || state.active_watcher,
  );
}

/** Real GitHub-backed marker store. Tests inject a fake with the same shape. */
const MARKER_STORE = {
  load: loadStateFromIssue,
  save: saveStateToIssue,
  create: createStateMarkerComment,
  list: listStateMarkerComments,
  remove: deleteStateMarkerComment,
};

function markerIsLive(body) {
  try {
    return ledgerHasLiveContent(parseStateFromCommentBody(body));
  } catch {
    return false;
  }
}

/**
 * Create the first marker without ever publishing an empty ledger over live content.
 *
 * Another writer can land a marker after the bootstrap's read and before this
 * create. `saveStateToIssue` would then PATCH that marker with the empty state,
 * so this path POSTs instead. It refuses to POST when any marker exists, and
 * after the POST it removes its own still-empty comment if another marker holds
 * live content. The caller's read-back then adopts the live marker.
 */
async function createMarkerIfAbsent(issueNumber, state, token, store) {
  if ((await store.list(issueNumber, token)).length > 0) {
    return { commentId: null, created: false };
  }
  const commentId = await store.create(issueNumber, state, token);
  const markers = await store.list(issueNumber, token);
  const ours = markers.find((marker) => marker.id === commentId);
  const liveElsewhere = markers.some(
    (marker) => marker.id !== commentId && markerIsLive(marker.body),
  );
  if (ours && !markerIsLive(ours.body) && liveElsewhere) {
    await store.remove(commentId, token);
    return { commentId: null, created: false };
  }
  return { commentId, created: true };
}

async function ensureMarkerComment(issueNumber, token, write, store = MARKER_STORE) {
  const loaded = await store.load(issueNumber, token);
  if (loaded.commentId) {
    return { initialized: false, comment_id: loaded.commentId };
  }
  if (!write) {
    return { initialized: false, comment_id: null, needs_write: true };
  }
  const saved = await commitStateMutation({
    issueNumber,
    token,
    loadState: store.load,
    saveState(issue, state, tok, commentId) {
      return commentId
        ? store.save(issue, state, tok, commentId)
        : createMarkerIfAbsent(issue, state, tok, store);
    },
    mutate(state) {
      if (ledgerHasLiveContent(state)) {
        return { state, initialized: false };
      }
      return { state: createEmptyState(), initialized: true };
    },
  });
  return {
    initialized: saved.written === true && saved.initialized !== false,
    comment_id: saved.commentId,
  };
}

function printRepoVariableInstructions(issueNumber) {
  console.log('');
  console.log('Manual step (requires repo admin / actions:write on token):');
  const { owner, repo } = resolveRepository();
  console.log(`  gh variable set UAT_COORDINATION_ISSUE --body "${issueNumber}" --repo ${owner}/${repo}`);
  console.log('Or: Settings → Secrets and variables → Actions → Variables');
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const token = getToken();
  if (!token) {
    console.error('uat_coordinator_bootstrap: GITHUB_TOKEN or GH_TOKEN required');
    process.exit(1);
  }

  const { owner, repo } = resolveRepository();
  if (flags.write) {
    await ensureLabels(owner, repo, token);
  }

  let issueNumber = flags.issue;
  if (!issueNumber) {
    const existing = findExistingIssue();
    issueNumber = existing?.number || null;
  }

  if (!issueNumber && !flags.write) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'coordination_issue_missing',
      hint: 'Re-run with --write to create the issue',
    }, null, 2));
    process.exit(1);
  }

  issueNumber = await createOrUpdateIssue(owner, repo, token, issueNumber, flags.write);
  if (!issueNumber) {
    console.error('uat_coordinator_bootstrap: could not resolve issue number');
    process.exit(1);
  }

  if (flags.pin && flags.write) {
    pinIssue(issueNumber);
  }

  const marker = await ensureMarkerComment(issueNumber, token, flags.write);
  const result = {
    ok: true,
    issue_number: issueNumber,
    issue_url: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
    marker,
    repo_variable: 'UAT_COORDINATION_ISSUE',
    repo_variable_value: String(issueNumber),
    write: flags.write,
  };

  console.log(JSON.stringify(result, null, 2));
  printRepoVariableInstructions(issueNumber);

  if (flags.write) {
    process.env.UAT_COORDINATION_ISSUE = String(issueNumber);
    try {
      execFileSync('node', ['scripts/uat_queue_runtime.js', 'health-check'], {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: { ...process.env, UAT_COORDINATION_ISSUE: String(issueNumber) },
      });
    } catch {
      process.exit(1);
    }
  }
}

module.exports = {
  COORDINATION_TITLE,
  COORDINATION_LABELS,
  MARKER_STORE,
  ensureMarkerComment,
  ledgerHasLiveContent,
  renderIssueBody,
  parseArgs,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`uat_coordinator_bootstrap: ${err.message}`);
    process.exit(1);
  });
}
