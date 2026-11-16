#!/usr/bin/env node
'use strict';

/**
 * Queue Cursor Bugbot when Copilot PR review is absent on main-target PRs.
 * Policy: docs/agent-efficiency/pr-review-cost-efficiency.md §Automatic review fallback
 *
 *   node scripts/cursor_review_fallback.js run --pr <n|url> [--dry-run]
 */

const { spawnSync } = require('child_process');
const { parseFlags } = require('./lib/github_issue_workflow_lib');
const {
  COPILOT_REQUEST_GRACE_MS,
  assessCopilotStatus,
  assessCursorBugbotStatus,
  parsePrRef,
} = require('./lib/babysit_pr_reviews_lib');
const { queueBugbotReview } = require('./lib/cursor_bugbot_api');
const { resolveRepository } = require('./lib/execute_plan_project');

const MARKER = '<!-- cursor-bugbot-fallback-requested -->';
const SLEEP_MS = COPILOT_REQUEST_GRACE_MS + 45_000;

function ghJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || 'null');
}

function ghPaginated(path) {
  return (ghJson(['api', '--paginate', '--slurp', path]) || []).flat();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findFallbackRequestTime(issueComments) {
  for (const comment of issueComments || []) {
    if (String(comment.body || '').includes(MARKER)) {
      return comment.created_at;
    }
  }
  return null;
}

function fetchCheckRuns(repoSlug, headSha) {
  return ghPaginated(`repos/${repoSlug}/commits/${headSha}/check-runs?per_page=100`);
}

async function runForPr(flags) {
  const { owner, repo } = resolveRepository();
  const pr = parsePrRef(flags.pr, owner, repo);
  const repoSlug = `${pr.owner}/${pr.repo}`;
  const pull = ghJson(['api', `repos/${repoSlug}/pulls/${pr.number}`]);

  if (pull.draft) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'draft_pr' }));
    return 0;
  }
  if (pull.base?.ref !== 'main') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'base_not_main' }));
    return 0;
  }
  if (process.env.CURSOR_REVIEW_FALLBACK === 'off') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'fallback_disabled' }));
    return 0;
  }

  await sleep(SLEEP_MS);

  const reviews = ghPaginated(`repos/${repoSlug}/pulls/${pr.number}/reviews`);
  const reviewComments = ghPaginated(`repos/${repoSlug}/pulls/${pr.number}/comments`);
  const issueComments = ghPaginated(`repos/${repoSlug}/issues/${pr.number}/comments`);
  const checkRuns = fetchCheckRuns(repoSlug, pull.head.sha);
  const fallbackRequestedAt = findFallbackRequestTime(issueComments);

  const copilot = assessCopilotStatus({
    reviews,
    reviewComments,
    requestedReviewers: pull.requested_reviewers || [],
    createdAt: pull.created_at,
  });

  if (copilot.state !== 'absent') {
    console.log(
      JSON.stringify({ ok: true, skipped: true, reason: 'copilot_present', copilot: copilot.state }),
    );
    return 0;
  }

  const cursor = assessCursorBugbotStatus({
    reviews,
    reviewComments,
    checkRuns,
    copilot,
    fallbackRequestedAt,
  });

  if (cursor.state === 'pending' || cursor.state === 'complete') {
    console.log(
      JSON.stringify({ ok: true, skipped: true, reason: 'cursor_already_active', cursor: cursor.state }),
    );
    return 0;
  }

  const apiKey = process.env.CURSOR_API_KEY || process.env.cursor_api_key;
  if (!apiKey) {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'missing_cursor_api_key' }));
    return 0;
  }

  const prUrl = pull.html_url;
  const dryRun = flags['dry-run'] === true || process.env.CURSOR_BUGBOT_DRY_RUN === 'true';

  const queued = await queueBugbotReview({ prUrl, apiKey, dryRun });
  const body = `${MARKER}\nCursor Bugbot queued as Copilot fallback for ${prUrl} (request_id=${queued.request_id || 'n/a'}).`;

  ghJson([
    'api',
    '-X',
    'POST',
    `repos/${repoSlug}/issues/${pr.number}/comments`,
    '-f',
    `body=${body}`,
  ]);

  console.log(JSON.stringify({ ok: true, queued: true, dryRun, requestId: queued.request_id || null }));
  return 0;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (cmd !== 'run' || !flags.pr) {
    console.error('Usage: node scripts/cursor_review_fallback.js run --pr <n|url> [--dry-run]');
    process.exit(1);
  }
  if (flags['dry-run'] === 'true') flags['dry-run'] = true;

  runForPr(flags)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

main();