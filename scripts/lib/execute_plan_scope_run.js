'use strict';

/**
 * Execute-plan v2 scope check: gather GitHub state, run the pure matcher, publish the
 * `execute-plan-scope` commit status. Runs in Actions from trusted `main` code; PR code is never executed.
 * Spec: docs/agent-efficiency/plans/execute-plan-v2/work-packages-platform.md §WP7a.
 */

const crypto = require('crypto');
const { PullFilesOverflow } = require('./execute_plan_github');
const { computeApprovalHash, findControlComments } = require('./execute_plan_approval');
const { acceptedAuthorizationIds } = require('./execute_plan_ack');
const { loadSnapshotAtRef } = require('./execute_plan_snapshot_v2');
const {
  categorizePull,
  evaluateDiff,
  BUNDLE_BUDGET_FILE,
  validateBundleBudgetRatchet,
  ownPlanFiles,
  parseSupportHeadRef,
  validateSupportLinkage,
} = require('./execute_plan_scope');
const { findOwnerScopeAckReview } = require('./execute_plan_scope_ack');
const { deriveControl } = require('./execute_plan_control');
const { planIdFromRefs, findControlIssue, labelNames } = require('./execute_plan_plans');
const { SCOPE_CONTEXT, describeScope } = require('./execute_plan_scope_status');
const {
  evaluateNonPlanForbidden,
  forbiddenGateMode,
  nonPlanEvaluationToResult,
  nonPlanInfrastructureOutcome,
} = require('./execute_plan_scope_nonplan');

const CHECK_NAME = SCOPE_CONTEXT;
const CONFIG_PATH = '.github/execute-plan.config.json';
const SUMMARY_MAX_LINES = 50;

const UNSUPPORTED_INTEGRATION_SUMMARY =
  'PR targets the integration branch but is not a recognized phase, sync, sync-resolve, or support head. '
  + 'Plan-linked side fixes may use cursor/<plan>-support-<phase>-<n> (integration) or main (runbooks §7.5).';

const result = (conclusion, title, summary, planId = null, extra = {}) => ({ conclusion, title, summary, planId, ...extra });

/** Sync-resolve and remedial PRs keep a normal scope evaluation while the plan is stopped (PR4). */
function exemptFromStopPublish(category) {
  return category === 'sync-resolve' || category === 'remedial' || category === 'support';
}
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function statusMarker(planId) {
  return `<!-- execute-plan-status:${planId} -->`;
}

/**
 * Parsed JSON block of the status comment (contracts §3.5), or null. Only a comment written by
 * `botLogin` counts: on a public repo anyone can post a comment carrying the marker.
 */
function parseStatusComment(comments, planId, botLogin) {
  const marker = statusMarker(planId);
  const comment = comments.find(
    (c) => String(c.body || '').split('\n', 1)[0].trim() === marker && c.user && c.user.login === botLogin,
  );
  if (!comment) return null;
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(comment.body);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function loadConfig(client) {
  const file = await client.getFileAtRef(CONFIG_PATH, 'main');
  if (!file) throw new Error(`${CONFIG_PATH} not found on main`);
  return JSON.parse(file.content);
}

/** Own plan files in the diff must match the approved bytes at the PR head (WP7a rule 6). */
async function verifyOwnPlanFiles(client, snapshot, headSha, files) {
  const planPath = snapshot.plan_file;
  const snapPath = `.agents/plans/${snapshot.plan_id}.snapshot.json`;
  const inDiff = [planPath, snapPath].filter((p) => files.includes(p));
  if (inDiff.length === 0) return false;
  for (const p of inDiff) {
    const file = await client.getFileAtRef(p, headSha);
    if (!file) return false;
    if (p === planPath) {
      if (sha256Hex(file.content) !== snapshot.plan_file_sha256) return false;
    } else {
      let parsed;
      try {
        parsed = JSON.parse(file.content);
      } catch {
        return false;
      }
      if (parsed.approval_hash !== snapshot.approval_hash || computeApprovalHash(parsed) !== snapshot.approval_hash) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Files in the PR whose blob matches `main` tip (release no-ops; side fixes and sync merges already on main).
 * @param {{ allowSymmetricDelete?: boolean, neverSkip?: Set<string> }} opts
 */
async function filesUnchangedOnMain(client, headSha, files, opts = {}) {
  const { allowSymmetricDelete = false, neverSkip = new Set() } = opts;
  const unchanged = new Set();
  if (!files.length) return unchanged;
  const [headShas, mainShas] = await Promise.all([
    client.getFileShasAtRef(files, headSha),
    client.getFileShasAtRef(files, 'main'),
  ]);
  for (const file of files) {
    if (neverSkip.has(file)) continue;
    const headShaBlob = headShas.get(file);
    const mainShaBlob = mainShas.get(file);
    if (headShaBlob && mainShaBlob && headShaBlob === mainShaBlob) {
      unchanged.add(file);
      continue;
    }
    // sync-resolve only: both integration and main already deleted the same path (trees omit absent blobs).
    if (allowSymmetricDelete && headShaBlob == null && mainShaBlob == null) unchanged.add(file);
  }
  return unchanged;
}

function renderSummary(evaluation) {
  if (evaluation.title === 'unsupported') return UNSUPPORTED_INTEGRATION_SUMMARY;
  const lines = [];
  if (evaluation.violations.length === 0) lines.push('No violations.');
  else {
    lines.push(`${evaluation.violations.length} violation(s):`);
    for (const v of evaluation.violations.slice(0, SUMMARY_MAX_LINES)) lines.push(`- \`${v.file}\`: ${v.reason}`);
    if (evaluation.violations.length > SUMMARY_MAX_LINES) {
      lines.push(`- … and ${evaluation.violations.length - SUMMARY_MAX_LINES} more`);
    }
  }
  if (evaluation.advisoryUnclassified && evaluation.advisoryUnclassified.length) {
    lines.push('', 'Unclassified (advisory):');
    for (const f of evaluation.advisoryUnclassified.slice(0, SUMMARY_MAX_LINES)) lines.push(`- \`${f}\``);
    if (evaluation.advisoryUnclassified.length > SUMMARY_MAX_LINES) {
      lines.push(`- … and ${evaluation.advisoryUnclassified.length - SUMMARY_MAX_LINES} more`);
    }
  }
  if (evaluation.ownerApprovedForbidden && evaluation.ownerApprovedForbidden.length) {
    const reviewId = evaluation.scopeAckReviewId;
    const heading = reviewId
      ? `Forbidden — owner-approved (review #${reviewId}):`
      : 'Forbidden — owner-approved:';
    lines.push('', heading);
    for (const file of evaluation.ownerApprovedForbidden.slice(0, SUMMARY_MAX_LINES)) lines.push(`- \`${file}\``);
    if (evaluation.ownerApprovedForbidden.length > SUMMARY_MAX_LINES) {
      lines.push(`- … and ${evaluation.ownerApprovedForbidden.length - SUMMARY_MAX_LINES} more`);
    }
  }
  if (evaluation.companionsUsed.length > 0) {
    lines.push('', `Companions used (${evaluation.companionsUsed.length}):`);
    for (const f of evaluation.companionsUsed) lines.push(`- \`${f}\``);
  }
  return lines.join('\n');
}

/** Control issue → config, status comment, snapshot at `init_sha`, and the derived STOP state. Throws when any is unusable. */
async function loadPlanControl(client, issue, planId, now) {
  const config = await loadConfig(client);
  const comments = await client.listIssueComments(issue.number);
  const accepted = await acceptedAuthorizationIds(client, comments);
  const status = parseStatusComment(comments, planId, config.bot_login);
  if (!status || typeof status.init_sha !== 'string') throw new Error('status comment with init_sha not found');
  const { snapshot } = await loadSnapshotAtRef(client, planId, status.init_sha);
  const control = findControlComments(comments, snapshot, config, { accepted });
  const stopped = deriveControl({ ...control, labels: labelNames(issue), status }, { now: new Date(now).toISOString() });
  return { snapshot, stopped, control, accepted };
}

/** @returns {Promise<{ conclusion: string, title: string, summary: string, planId: string|null }>} */
async function runScopeCheck(client, { prNumber, headSha, headRef, baseRef, headRepo, repo, now }) {
  const mode = forbiddenGateMode();
  const supportHead = parseSupportHeadRef(headRef);
  if (supportHead && headRepo !== repo) {
    return result('failure', 'unblocks', 'support PR must not come from a fork', supportHead.planId);
  }
  if (headRepo !== repo) return result('success', 'ok', 'not an execute-plan PR (fork)');

  const planId = planIdFromRefs({ head_ref: headRef, base_ref: baseRef });
  // The control issue is looked up before any PR read, as before #1980. A PR with no active plan
  // issue is a non-plan PR: outside `main` it returns here with no GitHub or config read.
  const issue = planId ? await findControlIssue(client, planId) : null;
  const nonPlan = !(planId && issue);
  if (!supportHead && nonPlan && baseRef !== 'main') return result('success', 'ok', 'not an execute-plan PR');

  let config;
  try {
    config = await loadConfig(client);
  } catch (e) {
    if (nonPlan) return nonPlanInfrastructureOutcome('config', e, mode);
    return result('failure', 'error', e.message, planId);
  }

  let files;
  let prAuthor = null;
  let pullBody = '';
  try {
    const pull = await client.getPull(prNumber);
    prAuthor = pull.user && pull.user.login;
    pullBody = pull.body || '';
    const pullFiles = await client.listPullFiles(prNumber);
    files = [...new Set(pullFiles.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  } catch (e) {
    if (nonPlan) {
      if (e instanceof PullFilesOverflow) return nonPlanInfrastructureOutcome('file list', e, mode);
      return nonPlanInfrastructureOutcome('PR load', e, mode);
    }
    if (e instanceof PullFilesOverflow) return result('failure', 'too-many-files', e.message, planId);
    throw e;
  }

  // Owner ack is best-effort on plan PRs (an unreadable list means no ack, as before #1980).
  // Non-plan PRs fail closed through the infra outcome instead.
  let scopeAckReview = null;
  try {
    const reviews = await client.listPullReviews(prNumber);
    scopeAckReview = findOwnerScopeAckReview(reviews, {
      headSha,
      owners: config.owners || [],
      botLogin: config.bot_login,
    });
  } catch (e) {
    if (nonPlan) return nonPlanInfrastructureOutcome('reviews', e, mode);
  }

  if (supportHead) {
    if (!planId || !issue) {
      return result(
        'failure',
        'unblocks',
        'support PR requires an active execute-plan control issue',
        planId || supportHead.planId,
      );
    }
  } else if (nonPlan) {
    const evaluation = evaluateNonPlanForbidden({
      files,
      scopeAckReview,
      mode,
      prAuthor,
      owners: config.owners || [],
    });
    return nonPlanEvaluationToResult(evaluation, null);
  }

  let snapshot;
  let stopped;
  try {
    ({ snapshot, stopped } = await loadPlanControl(client, issue, planId, now));
  } catch (e) {
    return result('failure', 'error', e.message, planId);
  }

  if (supportHead && baseRef !== snapshot.integration_branch) {
    return result('failure', 'unblocks', 'support PRs must target the plan integration branch', planId);
  }

  const { category, phaseId } = categorizePull({ head_ref: headRef, base_ref: baseRef }, snapshot);
  if (category === 'support') {
    const linkErr = validateSupportLinkage({ body: pullBody, snapshot, headRef, phaseId });
    if (linkErr) return result('failure', 'unblocks', linkErr, planId);
    if (stopped.stopped && (stopped.reason === 'approval-invalid' || stopped.reason === 'expired' || stopped.reason === 'revoked')) {
      return result('failure', 'unblocks', `support PR requires valid plan approval (${stopped.reason})`, planId);
    }
  }
  const stopExempt = stopped.stopped && exemptFromStopPublish(category);
  const ownPlanFilesVerified = category === 'release' && files.length > 0
    ? await verifyOwnPlanFiles(client, snapshot, headSha, files)
    : false;
  // Release and sync-resolve PRs carry `main`'s own commits: files identical to `main` are not plan changes.
  const neverSkipOnMain = new Set(ownPlanFiles(snapshot));
  const unchangedOnMain = category === 'release' || category === 'sync-resolve'
    ? await filesUnchangedOnMain(client, headSha, files, {
        allowSymmetricDelete: category === 'sync-resolve',
        neverSkip: neverSkipOnMain,
      })
    : new Set();
  const evaluation = evaluateDiff({
    files, snapshot, category, phaseId, ownPlanFilesVerified, stopped, unchangedOnMain, scopeAckReview,
  });
  if (category === 'phase' && files.includes(BUNDLE_BUDGET_FILE)) {
    const cmp = await client.compare(baseRef, headSha);
    const mergeBase = cmp.merge_base_commit && cmp.merge_base_commit.sha;
    if (!mergeBase) {
      return result('failure', 'drift', 'could not resolve merge base for bundle ratchet', planId);
    }
    const headFile = await client.getFileAtRef(BUNDLE_BUDGET_FILE, headSha);
    const baseFile = await client.getFileAtRef(BUNDLE_BUDGET_FILE, mergeBase);
    if (!headFile || !baseFile) {
      return result('failure', 'drift', 'web-bundle-budget.json missing on base or head', planId);
    }
    const err = validateBundleBudgetRatchet(baseFile.content, headFile.content);
    if (err) {
      return result('failure', 'forbidden', err, planId);
    }
  }
  const summary = stopped.stopped && !stopExempt ? `plan stopped: ${stopped.reason}` : renderSummary(evaluation);
  return result(evaluation.conclusion, evaluation.title, summary, planId, { exemptStopPublish: stopExempt });
}

/** Post the `execute-plan-scope` commit status on `headSha`. */
async function publishScopeCheck(client, { headSha, conclusion, title, summary, targetUrl }) {
  return client.createCommitStatus(headSha, {
    state: conclusion === 'success' ? 'success' : 'failure',
    context: CHECK_NAME,
    description: describeScope(title, summary),
    target_url: targetUrl,
  });
}

/**
 * Publish an evaluated outcome. A green result for a plan PR is re-checked against the plan's STOP
 * state just before posting: a run that evaluated before a STOP must not post after `enforce-stop`'s
 * `plan-stopped` and turn the head green again. A failing re-check publishes a failure (fail closed).
 */
async function publishScopeResult(client, { headSha, outcome, targetUrl, now }) {
  let final = outcome;
  if (outcome.conclusion === 'success' && outcome.planId && !outcome.exemptStopPublish) {
    try {
      const issue = await findControlIssue(client, outcome.planId);
      if (!issue) throw new Error(`control issue for ${outcome.planId} not found`);
      const { stopped } = await loadPlanControl(client, issue, outcome.planId, now);
      if (stopped.stopped) final = result('failure', 'plan-stopped', `plan stopped: ${stopped.reason}`, outcome.planId);
    } catch (e) {
      final = result('failure', 'recheck-error', `scope check could not confirm the plan state: ${e.message}`, outcome.planId);
    }
  }
  await publishScopeCheck(client, { headSha, conclusion: final.conclusion, title: final.title, summary: final.summary, targetUrl });
  return final;
}

/** `check-diff --pr <n> [--repo owner/name] [--publish]`: run the check for a PR from a terminal. */
async function cliCheckDiff(flags, { client: injected } = {}) {
  const repo = flags.repo || process.env.GITHUB_REPOSITORY;
  const prNumber = Number(flags.pr);
  if (!repo || !Number.isInteger(prNumber) || prNumber < 1) {
    throw new Error('check-diff requires --pr <number> and --repo <owner/name> (or GITHUB_REPOSITORY)');
  }
  // Only a status set with a workflow GITHUB_TOKEN counts (ruleset app pin); one posted with a PAT is ignored.
  if (flags.publish && process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('check-diff --publish only runs inside GitHub Actions: a status posted with a personal token never counts');
  }
  const client = injected || require('./execute_plan_github').createGitHubClient({ repo });
  const pull = await client.getPull(prNumber);
  const outcome = await runScopeCheck(client, {
    prNumber,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    headRepo: pull.head.repo && pull.head.repo.full_name,
    repo,
    now: new Date(),
  });
  const final = flags.publish ? await publishScopeResult(client, { headSha: pull.head.sha, outcome, now: new Date() }) : outcome;
  console.log(JSON.stringify(final, null, 2));
  if (final.conclusion !== 'success') process.exitCode = 1;
}

module.exports = {
  CHECK_NAME,
  cliCheckDiff,
  parseStatusComment,
  publishScopeCheck,
  publishScopeResult,
  runScopeCheck,
};
