'use strict';

/**
 * `gh` wrapper for Claude Code cloud sessions, where the session proxy blocks GitHub GraphQL.
 * Put `scripts/ccr-bin` first on PATH; the babysit scripts then run unchanged.
 *
 * Answers exactly two GraphQL-backed calls, from REST and the CCR review-thread route:
 *   1. `gh api graphql` with the reviewThreads query of scripts/babysit_pr_reviews.js
 *   2. `gh pr view <pr> --json baseRefName,headRefName [--jq expr]` (scripts/babysit_sync_base.sh --pr)
 * Every other call goes to the real gh untouched, so other GraphQL calls still fail loudly.
 *
 * Fails closed: an unknown query shape, a malformed thread, or a review comment that no thread
 * accounts for exits 1 — the scripts read that as an error, never as "no threads".
 * Policy: docs/agent-efficiency/autonomous-pr-policy.md §Automatic reviews.
 * @module scripts/lib/ccr_gh_shim_lib
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

/** Field set scripts/babysit_pr_reviews.js asks for (whitespace-insensitive match). */
const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor }
      nodes { isResolved comments(first: 10) { nodes { author { login } body path line url } } } } } } }`;

const THREAD_COMMENT_CAP = 10;
const PR_VIEW_FIELDS = Object.freeze({ baseRefName: '.base.ref', headRefName: '.head.ref' });

class ShimError extends Error {}

const squash = (text) => String(text || '').replace(/\s+/g, '');

function isBabysitReviewThreadsQuery(query) {
  return squash(query) === squash(REVIEW_THREADS_QUERY);
}

/** `-f key=value` / `-F key=value` pairs of a `gh api` call. */
function parseFieldFlags(args) {
  const fields = {};
  for (let i = 0; i < args.length; i += 1) {
    if ((args[i] === '-f' || args[i] === '-F') && args[i + 1] !== undefined) {
      const pair = args[i + 1];
      const eq = pair.indexOf('=');
      if (eq > 0) fields[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    }
  }
  return fields;
}

/** GraphQL `author.login` drops the `[bot]` suffix that REST `user.login` keeps. */
function graphqlLogin(login) {
  return String(login || '').replace(/\[bot\]$/, '');
}

/**
 * GraphQL `reviewThreads` response built from `GET …/pulls/{n}/ccr/review_threads` (resolved state,
 * comment ids) joined with the REST review comments (author, body, path, line, url).
 * Every REST comment must belong to exactly one thread, so a truncated or empty thread list fails.
 */
function buildReviewThreadsResponse({ threads, comments }) {
  if (!Array.isArray(threads)) throw new ShimError('ccr/review_threads did not return an array');
  if (!Array.isArray(comments)) throw new ShimError('review comments did not return an array');
  const byId = new Map(comments.map((c) => [c.id, c]));
  const seen = new Set();

  const nodes = threads.map((thread, index) => {
    const ids = thread?.comment_ids;
    if (typeof thread?.resolved !== 'boolean' || !Array.isArray(ids) || ids.length === 0) {
      throw new ShimError(`thread ${index} is malformed (needs boolean resolved and comment_ids)`);
    }
    const threadComments = ids.map((id) => {
      const comment = byId.get(id);
      if (!comment) throw new ShimError(`thread comment ${id} is missing from the REST review comments`);
      if (seen.has(id)) throw new ShimError(`comment ${id} appears in more than one thread`);
      seen.add(id);
      return comment;
    });
    threadComments.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
    if (threadComments[0].in_reply_to_id) {
      throw new ShimError(`thread ${index} has no root comment (first is a reply to ${threadComments[0].in_reply_to_id})`);
    }
    return {
      isResolved: thread.resolved,
      comments: {
        nodes: threadComments.slice(0, THREAD_COMMENT_CAP).map((c) => ({
          author: { login: graphqlLogin(c.user?.login) },
          body: c.body || '',
          path: c.path || null,
          line: c.line ?? null,
          url: c.html_url || null,
        })),
      },
    };
  });

  const orphans = comments.filter((c) => !seen.has(c.id));
  if (orphans.length > 0) {
    throw new ShimError(`${orphans.length} REST review comment(s) belong to no CCR thread (e.g. ${orphans[0].id})`);
  }
  return {
    data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } },
  };
}

function slugFromRemote(remoteUrl) {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(String(remoteUrl || '').trim());
  return match ? match[1] : null;
}

/**
 * REST call that replaces `gh pr view <pr> --json <fields> [--jq expr]`, or null when the call
 * asks for anything this wrapper does not translate (it then goes to the real gh).
 */
function planPrView(args, { remoteUrl = null } = {}) {
  if (args[0] !== 'pr' || args[1] !== 'view') return null;
  const ref = args[2];
  const jsonAt = args.indexOf('--json');
  const jqAt = args.indexOf('--jq');
  const known = new Set([ref, '--json', args[jsonAt + 1], '--jq', args[jqAt + 1]]);
  if (!ref || ref.startsWith('-') || jsonAt < 0 || args.slice(2).some((a) => !known.has(a))) return null;
  const fields = String(args[jsonAt + 1] || '').split(',').filter(Boolean);
  if (fields.length === 0 || fields.some((f) => !PR_VIEW_FIELDS[f])) return null;

  let slug;
  let number;
  const url = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(ref);
  if (url) {
    [, slug, number] = url;
  } else if (/^\d+$/.test(ref)) {
    slug = slugFromRemote(remoteUrl);
    number = ref;
    if (!slug) throw new ShimError('cannot resolve owner/repo from the origin remote');
  } else {
    return null;
  }
  const projection = `{${fields.map((f) => `${f}: ${PR_VIEW_FIELDS[f]}`).join(', ')}}`;
  const jq = jqAt > 0 ? `${projection} | (${args[jqAt + 1]})` : projection;
  return ['api', `repos/${slug}/pulls/${number}`, '--jq', jq];
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The real gh: `$REAL_GH`, else the first `gh` on PATH that is not this wrapper. */
function findRealGh({ env = process.env, selfPath } = {}) {
  if (env.REAL_GH) return env.REAL_GH;
  const self = selfPath ? fs.realpathSync(selfPath) : null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'gh');
    if (isExecutable(candidate) && fs.realpathSync(candidate) !== self) return candidate;
  }
  throw new ShimError('real gh not found on PATH (set REAL_GH)');
}

/** Runs the real gh; non-zero exit becomes a ShimError carrying its output. */
function runRealGh(realGh, args, { json = true } = {}) {
  const result = spawnSync(realGh, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new ShimError(`gh ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return json ? JSON.parse(result.stdout || 'null') : result.stdout;
}

function reviewThreadsFromGitHub(realGh, fields) {
  if (fields.after) throw new ShimError('pagination cursor received, but this wrapper returns every thread in one page');
  const number = Number(fields.number);
  if (!fields.owner || !fields.repo || !Number.isInteger(number)) throw new ShimError('missing owner, repo or number');
  const slug = `${fields.owner}/${fields.repo}`;
  const threads = runRealGh(realGh, ['api', `repos/${slug}/pulls/${number}/ccr/review_threads`]);
  const pages = runRealGh(realGh, ['api', '--paginate', '--slurp', `repos/${slug}/pulls/${number}/comments?per_page=100`]);
  return buildReviewThreadsResponse({ threads, comments: (pages || []).flat() });
}

function readOriginRemote() {
  try {
    return execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/** Entry point for scripts/ccr-bin/gh. Returns the process exit code. */
function main(args, { env = process.env, selfPath, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const realGh = findRealGh({ env, selfPath });
    if (args[0] === 'api' && args[1] === 'graphql') {
      const fields = parseFieldFlags(args.slice(2));
      if (/reviewThreads/.test(fields.query || '')) {
        if (!isBabysitReviewThreadsQuery(fields.query)) {
          throw new ShimError('unrecognised reviewThreads query; update scripts/lib/ccr_gh_shim_lib.js to match');
        }
        stdout.write(JSON.stringify(reviewThreadsFromGitHub(realGh, fields)));
        return 0;
      }
    }
    const restPrView = args[0] === 'pr' && args[1] === 'view' ? planPrView(args, { remoteUrl: readOriginRemote() }) : null;
    if (restPrView) {
      stdout.write(runRealGh(realGh, restPrView, { json: false }));
      return 0;
    }
    return spawnSync(realGh, args, { stdio: 'inherit' }).status ?? 1;
  } catch (error) {
    stderr.write(`ccr-gh: ${error.message}\n`);
    return 1;
  }
}

module.exports = {
  REVIEW_THREADS_QUERY,
  ShimError,
  buildReviewThreadsResponse,
  findRealGh,
  graphqlLogin,
  isBabysitReviewThreadsQuery,
  main,
  parseFieldFlags,
  planPrView,
  slugFromRemote,
};
