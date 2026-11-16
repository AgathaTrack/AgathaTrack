#!/usr/bin/env node
'use strict';

/**
 * Automated review for agent-authored PRs to `main`:
 *   1. request Copilot with the owner's token (the ruleset requests it as the bot author, which has no licence);
 *   2. if Copilot has not started within PR_REVIEW_WAIT_MIN, launch a review-only Cursor agent.
 *
 *   node scripts/pr_review_request.js --pr <n> [--dry-run]
 *
 * Policy: docs/agent-efficiency/pr-review-cost-efficiency.md §Agent-authored PRs
 */

const { rest } = require('../.github/scripts/github-project-lib');
const { launchPlanAgent, workerLaunchEnvVars } = require('../.github/scripts/execute-plan-launch');
const { parseFlags } = require('./lib/github_issue_workflow_lib');
const {
  COPILOT_REVIEWER_LOGINS,
  STATES,
  buildCursorReviewPrompt,
  buildStateCommentBody,
  copilotRequested,
  copilotStarted,
  parseBotAuthors,
  parseStateMarker,
  shouldHandlePr,
} = require('./lib/pr_review_request_lib');

const DEFAULT_REVIEW_MODEL = 'composer-2.5';
const MAX_PAGES = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listAll(path, token) {
  const items = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await rest('GET', `${path}${sep}per_page=100&page=${page}`, token);
    items.push(...(batch || []));
    if (!batch || batch.length < 100) return items;
  }
  return items;
}

function positiveNumber(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function snapshot(ctx) {
  const { base, token } = ctx;
  const [pull, events, reviews, reviewComments] = await Promise.all([
    rest('GET', `${base}/pulls/${ctx.prNumber}`, token),
    listAll(`${base}/issues/${ctx.prNumber}/events`, token),
    listAll(`${base}/pulls/${ctx.prNumber}/reviews`, token),
    listAll(`${base}/pulls/${ctx.prNumber}/comments`, token),
  ]);
  return { pull, events, reviews, reviewComments };
}

async function writeState(ctx, state) {
  const body = buildStateCommentBody({ ...state, updated_at: new Date().toISOString() });
  console.log(`state -> ${state.state}${state.reason ? ` (${state.reason})` : ''}`);
  if (ctx.dryRun) return;
  if (ctx.stateCommentId) {
    await rest('PATCH', `${ctx.base}/issues/comments/${ctx.stateCommentId}`, ctx.token, { body });
    return;
  }
  const created = await rest('POST', `${ctx.base}/issues/${ctx.prNumber}/comments`, ctx.token, { body });
  ctx.stateCommentId = created?.id ?? null;
}

/** Tries both documented reviewer logins; returns null on success, else the last error message. */
async function requestCopilot(ctx) {
  let lastError = 'no reviewer login accepted';
  for (const login of COPILOT_REVIEWER_LOGINS) {
    try {
      await rest('POST', `${ctx.base}/pulls/${ctx.prNumber}/requested_reviewers`, ctx.ownerToken, {
        reviewers: [login],
      });
      return null;
    } catch (error) {
      lastError = error.message;
    }
  }
  return lastError;
}

async function cancelCopilotRequest(ctx) {
  for (const login of COPILOT_REVIEWER_LOGINS) {
    try {
      await rest('DELETE', `${ctx.base}/pulls/${ctx.prNumber}/requested_reviewers`, ctx.ownerToken, {
        reviewers: [login],
      });
      return;
    } catch {
      // Best effort: a stale request only keeps babysit waiting until its timeout.
    }
  }
}

async function launchCursorReview(ctx, pull) {
  if (!ctx.cursorApiKey) {
    await writeState(ctx, { state: STATES.UNAVAILABLE, reason: 'missing_cursor_api_key' });
    return;
  }
  const prompt = buildCursorReviewPrompt({
    repoSlug: ctx.repoSlug,
    prNumber: ctx.prNumber,
    prUrl: pull.html_url,
    headSha: pull.head.sha,
  });
  if (ctx.dryRun) {
    console.log(`[dry-run] would launch ${ctx.model} review agent on ${pull.head.ref}`);
    return;
  }
  let launched;
  try {
    launched = await launchPlanAgent({
      apiKey: ctx.cursorApiKey,
      repoUrl: `https://github.com/${ctx.repoSlug}`,
      startingRef: pull.head.ref,
      prompt,
      model: ctx.model,
      envVars: workerLaunchEnvVars(ctx.botToken),
    });
  } catch (error) {
    console.error(`Cursor launch failed: ${error.message}`);
    await writeState(ctx, { state: STATES.UNAVAILABLE, reason: 'cursor_launch_failed' });
    process.exitCode = 1;
    return;
  }
  await writeState(ctx, {
    state: STATES.CURSOR_LAUNCHED,
    agent_url: launched.agentUrl,
    launched_at: new Date().toISOString(),
  });
}

async function run(ctx) {
  if (String(process.env.PR_REVIEW_FALLBACK || '').toLowerCase() === 'off') {
    console.log('PR_REVIEW_FALLBACK=off; nothing to do');
    return;
  }

  const first = await snapshot(ctx);
  const gate = shouldHandlePr(first.pull, ctx.botAuthors);
  if (!gate.ok) {
    console.log(`skip: ${gate.reason}`);
    return;
  }

  const issueComments = await listAll(`${ctx.base}/issues/${ctx.prNumber}/comments`, ctx.token);
  const marker = parseStateMarker(issueComments);
  ctx.stateCommentId = marker.commentId;
  if (marker.state && marker.state.state !== STATES.REQUESTED) {
    console.log(`skip: already handled (${marker.state.state})`);
    return;
  }

  if (copilotStarted(first)) {
    await writeState(ctx, { state: STATES.COPILOT });
    return;
  }

  if (!copilotRequested(first.pull)) {
    const error = ctx.ownerToken ? (ctx.dryRun ? null : await requestCopilot(ctx)) : 'missing_owner_token';
    if (error) {
      console.log(`Copilot request failed: ${error}`);
      await launchCursorReview(ctx, first.pull);
      return;
    }
  }
  await writeState(ctx, { state: STATES.REQUESTED, requested_at: new Date().toISOString() });

  const deadline = Date.now() + ctx.waitMs;
  while (Date.now() < deadline) {
    await sleep(ctx.pollMs);
    const snap = await snapshot(ctx);
    if (snap.pull.state !== 'open') {
      console.log('PR closed while waiting; stopping');
      return;
    }
    if (copilotStarted(snap)) {
      await writeState(ctx, { state: STATES.COPILOT });
      return;
    }
  }

  if (ctx.ownerToken && !ctx.dryRun) await cancelCopilotRequest(ctx);
  const latest = await snapshot(ctx);
  await launchCursorReview(ctx, latest.pull);
}

function buildContext(flags, env = process.env) {
  const repoSlug = env.GITHUB_REPOSITORY;
  const prNumber = Number(flags.pr || env.PR_NUMBER);
  if (!repoSlug || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error('GITHUB_REPOSITORY and --pr <number> (or PR_NUMBER) are required');
  }
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is required');
  return {
    repoSlug,
    prNumber,
    base: `/repos/${repoSlug}`,
    token: env.GITHUB_TOKEN,
    ownerToken: env.OWNER_COPILOT_REQUEST_TOKEN || '',
    botToken: env.EXECUTE_PLAN_BOT_TOKEN || '',
    cursorApiKey: env.CURSOR_API_KEY || env.cursor_api_key || '',
    model: env.CURSOR_REVIEW_MODEL || DEFAULT_REVIEW_MODEL,
    botAuthors: parseBotAuthors(env.PR_REVIEW_BOT_AUTHORS),
    waitMs: positiveNumber(env.PR_REVIEW_WAIT_MIN, 8) * 60 * 1000,
    pollMs: positiveNumber(env.PR_REVIEW_POLL_SEC, 30) * 1000,
    dryRun: flags['dry-run'] === true || flags['dry-run'] === 'true' || env.DRY_RUN === 'true',
    stateCommentId: null,
  };
}

if (require.main === module) {
  const flags = parseFlags(process.argv.slice(2));
  Promise.resolve()
    .then(() => run(buildContext(flags)))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { buildContext, run };
