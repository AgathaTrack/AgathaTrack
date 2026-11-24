#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  REVIEW_THREADS_QUERY,
  ShimError,
  buildReviewThreadsResponse,
  findRealGh,
  isBabysitReviewThreadsQuery,
  parseFieldFlags,
  checkRollupFromRest,
  mergeableFromRest,
  planPrSnapshot,
  planPrView,
  pullSnapshot,
  slugFromRemote,
} = require('./lib/ccr_gh_shim_lib');

const ROOT = path.resolve(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'scripts/ccr-bin');

const comment = (id, fields = {}) => ({
  id,
  user: { login: 'copilot-pull-request-reviewer[bot]' },
  body: `comment ${id}`,
  path: 'a.js',
  line: 3,
  html_url: `https://github.com/o/r/pull/7#discussion_r${id}`,
  created_at: `2026-11-01T00:00:0${id % 10}Z`,
  ...fields,
});

const threadNodes = (response) => response.data.repository.pullRequest.reviewThreads.nodes;

test('drift guard: the query in scripts/babysit_pr_reviews.js is the one this wrapper answers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/babysit_pr_reviews.js'), 'utf8');
  const match = /const REVIEW_THREADS_QUERY = `([\s\S]*?)`;/.exec(source);
  assert.ok(match, 'REVIEW_THREADS_QUERY not found in babysit_pr_reviews.js');
  assert.equal(isBabysitReviewThreadsQuery(match[1]), true);
});

test('a reviewThreads query asking for other fields is not emulated', () => {
  const extra = REVIEW_THREADS_QUERY.replace('isResolved', 'isResolved isOutdated');
  assert.equal(isBabysitReviewThreadsQuery(extra), false);
});

test('parseFieldFlags reads -f and -F pairs, keeping "=" inside values', () => {
  assert.deepEqual(parseFieldFlags(['-f', 'query=a=b', '-F', 'number=7', '-f', 'owner=o']), {
    query: 'a=b',
    number: '7',
    owner: 'o',
  });
});

test('buildReviewThreadsResponse joins CCR threads with REST comments in GraphQL shape', () => {
  const response = buildReviewThreadsResponse({
    threads: [
      { resolved: false, comment_ids: [12, 11] },
      { resolved: true, comment_ids: [13] },
    ],
    comments: [
      comment(11),
      comment(12, { in_reply_to_id: 11, user: { login: 'pawpet-bot' } }),
      comment(13, { line: null }),
    ],
  });
  assert.equal(response.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage, false);
  const [open, done] = threadNodes(response);
  assert.equal(open.isResolved, false);
  assert.deepEqual(open.comments.nodes.map((c) => c.author.login), ['copilot-pull-request-reviewer', 'pawpet-bot']);
  assert.deepEqual(open.comments.nodes[0], {
    author: { login: 'copilot-pull-request-reviewer' },
    body: 'comment 11',
    path: 'a.js',
    line: 3,
    url: 'https://github.com/o/r/pull/7#discussion_r11',
  });
  assert.equal(done.isResolved, true);
  assert.equal(done.comments.nodes[0].line, null);
});

test('buildReviewThreadsResponse keeps at most 10 comments per thread, like the query', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
  const comments = ids.map((id, i) => comment(id, { in_reply_to_id: i === 0 ? undefined : 100 }));
  const [thread] = threadNodes(buildReviewThreadsResponse({ threads: [{ resolved: false, comment_ids: ids }], comments }));
  assert.equal(thread.comments.nodes.length, 10);
});

test('no threads and no comments is a real empty result', () => {
  assert.deepEqual(threadNodes(buildReviewThreadsResponse({ threads: [], comments: [] })), []);
});

for (const [name, input, pattern] of [
  ['an empty thread list while comments exist (truncated or wrong route)', { threads: [], comments: [comment(1)] }, /belong to no CCR thread/],
  ['a thread comment missing from REST', { threads: [{ resolved: false, comment_ids: [1, 2] }], comments: [comment(1)] }, /missing from the REST/],
  ['a comment claimed by two threads', { threads: [{ resolved: false, comment_ids: [1] }, { resolved: true, comment_ids: [1] }], comments: [comment(1)] }, /more than one thread/],
  ['a thread without a boolean resolved', { threads: [{ comment_ids: [1] }], comments: [comment(1)] }, /malformed/],
  ['a thread without comment ids', { threads: [{ resolved: false, comment_ids: [] }], comments: [] }, /malformed/],
  ['a thread whose first comment is a reply', { threads: [{ resolved: false, comment_ids: [2] }], comments: [comment(2, { in_reply_to_id: 1 })] }, /no root comment/],
  ['a non-array CCR response', { threads: { message: 'Not Found' }, comments: [] }, /did not return an array/],
]) {
  test(`fails closed on ${name}`, () => {
    assert.throws(() => buildReviewThreadsResponse(input), (error) => error instanceof ShimError && pattern.test(error.message));
  });
}

test('planPrView maps the babysit_sync_base.sh call to the REST pull endpoint', () => {
  const args = ['pr', 'view', '42', '--json', 'baseRefName,headRefName', '--jq', '[.baseRefName, .headRefName] | @tsv'];
  assert.deepEqual(planPrView(args, { remoteUrl: 'git@github.com:AgathaTrack/AgathaTrack.git' }), [
    'api',
    'repos/AgathaTrack/AgathaTrack/pulls/42',
    '--jq',
    '{baseRefName: .base.ref, headRefName: .head.ref} | ([.baseRefName, .headRefName] | @tsv)',
  ]);
});

test('planPrView takes owner/repo from a PR URL', () => {
  const plan = planPrView(['pr', 'view', 'https://github.com/o/r/pull/9', '--json', 'headRefName']);
  assert.deepEqual(plan, ['api', 'repos/o/r/pulls/9', '--jq', '{headRefName: .head.ref}']);
});

test('planPrView leaves calls it does not translate to the real gh', () => {
  assert.equal(planPrView(['pr', 'view', '42', '--json', 'title']), null);
  assert.equal(planPrView(['pr', 'view', '42']), null);
  assert.equal(planPrView(['pr', 'view', '42', '--json', 'baseRefName', '--web']), null);
  assert.equal(planPrView(['pr', 'checks', '42']), null);
});

test('slugFromRemote reads https and ssh remotes', () => {
  assert.equal(slugFromRemote('https://github.com/o/r.git\n'), 'o/r');
  assert.equal(slugFromRemote('git@github.com:o/r'), 'o/r');
  assert.equal(slugFromRemote('https://example.com/o/r'), null);
});

test('findRealGh skips the wrapper itself on PATH', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gh-real-'));
  const real = path.join(dir, 'gh');
  fs.writeFileSync(real, '#!/bin/sh\n', { mode: 0o755 });
  const env = { PATH: [BIN_DIR, dir].join(path.delimiter) };
  assert.equal(findRealGh({ env, selfPath: path.join(BIN_DIR, 'gh') }), real);
  assert.equal(findRealGh({ env: { ...env, REAL_GH: '/x/gh' }, selfPath: path.join(BIN_DIR, 'gh') }), '/x/gh');
  assert.throws(() => findRealGh({ env: { PATH: BIN_DIR }, selfPath: path.join(BIN_DIR, 'gh') }), /real gh not found/);
});

// End to end: the unchanged babysit_pr_reviews.js, with scripts/ccr-bin first on PATH and a fake "real" gh.
const FAKE_GH = `#!/usr/bin/env node
const routes = JSON.parse(require('fs').readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'));
const args = process.argv.slice(2);
const jqAt = args.indexOf('--jq');
const key = (jqAt >= 0 ? args.slice(0, jqAt) : args).join(' ');
if (key === '--version') { console.log('gh version 0.0.0'); process.exit(0); }
if (key.startsWith('api graphql') || key.startsWith('pr ')) { console.error('HTTP 403: GitHub GraphQL is not available'); process.exit(1); }
if (!(key in routes)) { console.error('unrecorded: ' + key); process.exit(1); }
if (jqAt < 0) { process.stdout.write(JSON.stringify(routes[key])); process.exit(0); }
// Like gh --jq: evaluate with jq, raw string output.
const jq = require('child_process').spawnSync('jq', ['-r', args[jqAt + 1]], { input: JSON.stringify(routes[key]), encoding: 'utf8' });
process.stderr.write(jq.stderr || '');
process.stdout.write(jq.stdout || '');
process.exit(jq.status ?? 1);
`;

function runReviews(cmd, routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gh-e2e-'));
  const fake = path.join(dir, 'fake-gh');
  fs.writeFileSync(fake, FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(routes));
  return spawnSync(process.execPath, [path.join(ROOT, 'scripts/babysit_pr_reviews.js'), cmd, '--pr', '7'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`,
      REAL_GH: fake,
      FAKE_GH_ROUTES: path.join(dir, 'routes.json'),
      GITHUB_REPOSITORY: 'o/r',
    },
  });
}

function prRoutes({ threads, comments }) {
  const base = 'api --paginate --slurp repos/o/r';
  return {
    'api repos/o/r/pulls/7': { requested_reviewers: [], created_at: '2026-11-01T00:00:00Z' },
    [`${base}/pulls/7/reviews`]: [[{ user: { login: 'copilot-pull-request-reviewer[bot]' }, state: 'COMMENTED' }]],
    [`${base}/pulls/7/comments`]: [comments],
    [`${base}/pulls/7/comments?per_page=100`]: [comments],
    [`${base}/issues/7/comments`]: [[]],
    'api repos/o/r/pulls/7/ccr/review_threads': threads,
  };
}

test('e2e: unchanged gate reports an unresolved Copilot thread through the wrapper (exit 2)', () => {
  const result = runReviews('gate', prRoutes({ threads: [{ resolved: false, comment_ids: [11] }, { resolved: true, comment_ids: [13] }], comments: [comment(11), comment(13)] }));
  assert.equal(result.status, 2, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.unresolvedCount, 1);
  assert.equal(report.threads[0].reviewer, 'copilot');
  assert.equal(report.threads[0].url, 'https://github.com/o/r/pull/7#discussion_r11');
});

test('e2e: unchanged gate is merge-ready when every thread is resolved (exit 0)', () => {
  const result = runReviews('gate', prRoutes({ threads: [{ resolved: true, comment_ids: [11] }], comments: [comment(11)] }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mergeReady, true);
});

test('e2e: an empty CCR thread list with comments present is an error, never merge-ready (exit 1)', () => {
  const result = runReviews('gate', prRoutes({ threads: [], comments: [comment(11)] }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /belong to no CCR thread/);
});

test('e2e: other GraphQL calls still reach the real gh and fail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gh-pass-'));
  const fake = path.join(dir, 'fake-gh');
  fs.writeFileSync(fake, FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'routes.json'), '{}');
  const result = spawnSync(path.join(BIN_DIR, 'gh'), ['api', 'graphql', '-f', 'query={ viewer { login } }'], {
    encoding: 'utf8',
    env: { ...process.env, REAL_GH: fake, FAKE_GH_ROUTES: path.join(dir, 'routes.json') },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GraphQL is not available/);
});

// End to end: the unchanged babysit_sync_base.sh --pr, copied into a scratch repo with a local origin.
function syncBaseRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gh-sync-'));
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, work);
  fs.mkdirSync(path.join(work, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts/babysit_sync_base.sh'), path.join(work, 'scripts/babysit_sync_base.sh'));
  fs.chmodSync(path.join(work, 'scripts/babysit_sync_base.sh'), 0o755);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'HEAD:main', 'HEAD:release');
  git(work, 'checkout', '-q', '-b', 'feature');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'feature work');
  git(work, 'checkout', '-q', 'main');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
  git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', 'feature');
  return { dir, work };
}

function runSyncBase(baseRef) {
  const { dir, work } = syncBaseRepo();
  const fake = path.join(dir, 'fake-gh');
  fs.writeFileSync(fake, FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({ 'api repos/o/r/pulls/7': { base: { ref: baseRef }, head: { ref: 'feature' } } }));
  return spawnSync('bash', ['scripts/babysit_sync_base.sh', '--pr', 'https://github.com/o/r/pull/7', '--check'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`, REAL_GH: fake, FAKE_GH_ROUTES: path.join(dir, 'routes.json') },
  });
}

const hasJq = spawnSync('jq', ['--version']).status === 0;

test('e2e: unchanged babysit_sync_base.sh --pr reads the PR base through the wrapper (behind main → exit 1)', { skip: !hasJq && 'jq not installed' }, () => {
  const result = runSyncBase('main');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /behind origin\/main by 1 commit\(s\) \(1 ahead\)/);
});

test('e2e: babysit_sync_base.sh counts against the checkout it is run in, not the one holding the script', { skip: !hasJq && 'jq not installed' }, () => {
  // Script from the wrapper's checkout (ROOT), run from a scratch repo that is behind main by one commit.
  const { dir, work } = syncBaseRepo();
  const fake = path.join(dir, 'fake-gh');
  fs.writeFileSync(fake, FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify({ 'api repos/o/r/pulls/7': { base: { ref: 'main' }, head: { ref: 'feature' } } }));
  const result = spawnSync('bash', [path.join(ROOT, 'scripts/babysit_sync_base.sh'), '--pr', 'https://github.com/o/r/pull/7', '--check'], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}`, REAL_GH: fake, FAKE_GH_ROUTES: path.join(dir, 'routes.json') },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /behind origin\/main by 1 commit\(s\) \(1 ahead\)/);
});

test('e2e: babysit_sync_base.sh --pr uses the base the PR names, not main (up to date with release → exit 0)', { skip: !hasJq && 'jq not installed' }, () => {
  const result = runSyncBase('release');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up to date with origin\/release \(1 commit\(s\) ahead\)/);
});

// Merge-preflight reads (scripts/babysit_merge_preflight.mjs) answered from REST.
const REMOTE = 'git@github.com:o/r.git';

test('planPrSnapshot maps the preflight calls to REST plans', () => {
  assert.deepEqual(planPrSnapshot(['repo', 'view', '--json', 'nameWithOwner'], { remoteUrl: REMOTE }), { kind: 'repo', slug: 'o/r' });
  assert.deepEqual(
    planPrSnapshot(['pr', 'view', '7', '--json', 'number,mergeable,statusCheckRollup'], { remoteUrl: REMOTE }),
    { kind: 'view', slug: 'o/r', number: '7', fields: ['number', 'mergeable', 'statusCheckRollup'] },
  );
  assert.deepEqual(
    planPrSnapshot(['pr', 'view', 'https://github.com/x/y/pull/9', '--json', 'labels'], { remoteUrl: REMOTE }),
    { kind: 'view', slug: 'x/y', number: '9', fields: ['labels'] },
  );
  assert.deepEqual(
    planPrSnapshot(['pr', 'list', '--state', 'open', '--base', 'cursor/a-integration-1', '--limit', '50', '--json', 'number,mergeable'], { remoteUrl: REMOTE }),
    { kind: 'list', slug: 'o/r', base: 'cursor/a-integration-1', limit: 50, fields: ['number', 'mergeable'] },
  );
});

test('planPrSnapshot leaves other calls to the real gh (or to planPrView for --jq)', () => {
  assert.equal(planPrSnapshot(['pr', 'view', '7', '--json', 'number', '--jq', '.number'], { remoteUrl: REMOTE }), null);
  assert.equal(planPrSnapshot(['pr', 'view', '7', '--json', 'title,body'], { remoteUrl: REMOTE }), null);
  assert.equal(planPrSnapshot(['pr', 'list', '--state', 'open', '--base', 'main', '--limit', '500', '--json', 'number'], { remoteUrl: REMOTE }), null);
  assert.equal(planPrSnapshot(['pr', 'merge', '7', '--squash'], { remoteUrl: REMOTE }), null);
  assert.equal(planPrSnapshot(['repo', 'view', '--json', 'url'], { remoteUrl: REMOTE }), null);
});

test('planPrSnapshot fails closed without an origin remote', () => {
  assert.throws(() => planPrSnapshot(['repo', 'view', '--json', 'nameWithOwner'], { remoteUrl: null }), /origin remote/);
});

test('mergeableFromRest maps REST values to GraphQL enums', () => {
  assert.equal(mergeableFromRest(true), 'MERGEABLE');
  assert.equal(mergeableFromRest(false), 'CONFLICTING');
  assert.equal(mergeableFromRest(null), 'UNKNOWN');
});

test('checkRollupFromRest: completed success is green, in-progress is pending, failures are not green', () => {
  const rollup = checkRollupFromRest({
    checkRuns: [
      { name: 'ci-gate', status: 'completed', conclusion: 'success' },
      { name: 'neutral', status: 'completed', conclusion: 'neutral' },
      { name: 'slow', status: 'in_progress', conclusion: null },
      { name: 'broken', status: 'completed', conclusion: 'failure' },
    ],
    statuses: [{ context: 'legacy/ci', state: 'success' }],
  });
  assert.deepEqual(rollup.map((c) => c.state), ['SUCCESS', 'NEUTRAL', 'PENDING', 'FAILURE', 'SUCCESS']);
  assert.equal(rollup[0].__typename, 'CheckRun');
  assert.equal(rollup[4].__typename, 'StatusContext');
});

test('pullSnapshot returns exactly the requested fields in GraphQL shape', () => {
  const pull = {
    number: 7,
    html_url: 'https://github.com/o/r/pull/7',
    base: { ref: 'main' },
    head: { ref: 'feature', sha: 'abc' },
    labels: [{ name: 'busy', color: 'ffffff' }],
    updated_at: '2026-11-24T00:00:00Z',
    title: 'T',
    mergeable: false,
  };
  assert.deepEqual(pullSnapshot(pull, ['number', 'url', 'labels', 'mergeable']), {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    labels: [{ name: 'busy' }],
    mergeable: 'CONFLICTING',
  });
});

test('e2e: gh pr view with snapshot fields is answered from REST, including the CI rollup', () => {
  const routes = {
    'api repos/o/r/pulls/7': {
      number: 7,
      html_url: 'https://github.com/o/r/pull/7',
      base: { ref: 'main' },
      head: { ref: 'feature', sha: 'abc' },
      labels: [{ name: 'light-plan' }],
      updated_at: '2026-11-24T00:00:00Z',
      title: 'T',
      mergeable: true,
    },
    'api --paginate --slurp repos/o/r/commits/abc/check-runs?per_page=100': [
      { check_runs: [{ name: 'ci-gate', status: 'completed', conclusion: 'success' }, { name: 'slow', status: 'in_progress', conclusion: null }] },
    ],
    'api repos/o/r/commits/abc/status?per_page=100': { statuses: [{ context: 'legacy/ci', state: 'success' }] },
  };
  const result = runGhWithRoutes(['pr', 'view', 'https://github.com/o/r/pull/7', '--json', 'number,mergeable,labels,statusCheckRollup'], routes);
  assert.equal(result.status, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.number, 7);
  assert.equal(out.mergeable, 'MERGEABLE');
  assert.deepEqual(out.labels, [{ name: 'light-plan' }]);
  assert.deepEqual(out.statusCheckRollup.map((c) => c.state), ['SUCCESS', 'PENDING', 'SUCCESS']);
});

test('e2e: gh pr list --base returns the open PRs, each projected from REST', () => {
  const routes = {
    'api repos/o/r/pulls?state=open&base=main&per_page=50': [{ number: 7 }, { number: 8 }],
    'api repos/o/r/pulls/7': { number: 7, html_url: 'u7', base: { ref: 'main' }, head: { ref: 'f7', sha: 's7' }, labels: [], updated_at: 't', title: 'a', mergeable: null },
    'api repos/o/r/pulls/8': { number: 8, html_url: 'u8', base: { ref: 'main' }, head: { ref: 'f8', sha: 's8' }, labels: [], updated_at: 't', title: 'b', mergeable: true },
  };
  const result = runGhWithRoutes(['pr', 'list', '--state', 'open', '--base', 'main', '--limit', '50', '--json', 'number,mergeable'], routes, syncBaseRepoRemote());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{ number: 7, mergeable: 'UNKNOWN' }, { number: 8, mergeable: 'MERGEABLE' }]);
});

test('e2e: gh repo view --json nameWithOwner is answered from the origin remote', () => {
  const result = spawnSync(path.join(BIN_DIR, 'gh'), ['repo', 'view', '--json', 'nameWithOwner'], {
    encoding: 'utf8',
    cwd: syncBaseRepoRemote(),
    env: { ...process.env, REAL_GH: '/nonexistent/gh' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { nameWithOwner: 'o/r' });
});

function runGhWithRoutes(args, routes, cwd = undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gh-snap-'));
  const fake = path.join(dir, 'fake-gh');
  fs.writeFileSync(fake, FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'routes.json'), JSON.stringify(routes));
  return spawnSync(path.join(BIN_DIR, 'gh'), args, {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, REAL_GH: fake, FAKE_GH_ROUTES: path.join(dir, 'routes.json') },
  });
}

function syncBaseRepoRemote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-gh-remote-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:o/r.git'], { cwd: dir });
  return dir;
}
