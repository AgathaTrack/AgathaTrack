'use strict';

// Execute-plan v2 GitHub client on the CCR routes (Claude Code cloud sessions, where GraphQL is blocked).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGitHubClient, GitHubError, isClaudeCodeSession } = require('../lib/execute_plan_github');
const { createFakeFetch } = require('./helpers/execute_plan_fake_fetch');

const R = '/repos/acme/app';
const THREADS = `GET ${R}/pulls/12/ccr/review_threads`;
const COMMENTS = `GET ${R}/pulls/12/comments?per_page=100`;

function client(routes, extra = {}) {
  const fake = createFakeFetch(routes);
  const gh = createGitHubClient({ repo: 'acme/app', token: 'tkn', fetchImpl: fake, sleep: async () => {}, ccr: true, ...extra });
  return { gh, fake };
}

const comment = (id, login, path, extra = {}) => ({
  id,
  user: { login },
  body: `c${id}`,
  path,
  line: 1,
  html_url: `https://github.com/acme/app/pull/12#discussion_r${id}`,
  created_at: `2026-11-01T00:00:${String(id).padStart(2, '0')}Z`,
  ...extra,
});

// One resolved thread (a.js), one unresolved Copilot thread with a reply (b.js), one unresolved human thread (c.js).
const COMMENT_LIST = [
  comment(1, 'x', 'a.js'),
  comment(2, 'copilot-pull-request-reviewer[bot]', 'b.js'),
  comment(3, 'pawpet-bot', 'b.js', { in_reply_to_id: 2 }),
  comment(4, 'y', 'c.js'),
];
const CCR_THREADS = [
  { resolved: true, outdated: false, path: 'a.js', line: 1, comment_ids: [1] },
  { resolved: false, outdated: false, path: 'b.js', line: 1, comment_ids: [2, 3] },
  { resolved: false, outdated: true, path: 'c.js', line: null, comment_ids: [4] },
];
const GRAPHQL_NODES = [
  { isResolved: true, path: 'a.js', comments: { nodes: [{ url: COMMENT_LIST[0].html_url, author: { login: 'x' } }] } },
  { isResolved: false, path: 'b.js', comments: { nodes: [{ url: COMMENT_LIST[1].html_url, author: { login: 'copilot-pull-request-reviewer' } }] } },
  { isResolved: false, path: 'c.js', comments: { nodes: [{ url: COMMENT_LIST[3].html_url, author: { login: 'y' } }] } },
];

test('isClaudeCodeSession reads CLAUDE_CODE_REMOTE', () => {
  assert.equal(isClaudeCodeSession({ CLAUDE_CODE_REMOTE: 'true' }), true);
  assert.equal(isClaudeCodeSession({ CLAUDE_CODE_REMOTE: 'false' }), false);
  assert.equal(isClaudeCodeSession({}), false);
});

test('the CCR routes are the default in a Claude Code cloud session; ccr overrides either way', () => {
  const saved = process.env.CLAUDE_CODE_REMOTE;
  try {
    process.env.CLAUDE_CODE_REMOTE = 'true';
    assert.equal(createGitHubClient({ repo: 'acme/app' }).usesCcrRoutes, true);
    assert.equal(createGitHubClient({ repo: 'acme/app', ccr: false }).usesCcrRoutes, false);
    delete process.env.CLAUDE_CODE_REMOTE;
    assert.equal(createGitHubClient({ repo: 'acme/app' }).usesCcrRoutes, false);
    assert.equal(createGitHubClient({ repo: 'acme/app', ccr: true }).usesCcrRoutes, true);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_REMOTE;
    else process.env.CLAUDE_CODE_REMOTE = saved;
  }
});

test('parity: the CCR route gives the same unresolved threads as GraphQL, with no GraphQL call', async () => {
  const { gh, fake } = client({ [THREADS]: { body: CCR_THREADS }, [COMMENTS]: { body: COMMENT_LIST } });
  const viaCcr = await gh.listUnresolvedThreads(12);
  const graphql = client({ 'POST /graphql': { body: { data: { repository: { pullRequest: { reviewThreads: { nodes: GRAPHQL_NODES } } } } } } }, { ccr: false });
  assert.deepEqual(viaCcr, await graphql.gh.listUnresolvedThreads(12));
  assert.deepEqual(viaCcr, [
    { url: COMMENT_LIST[1].html_url, path: 'b.js', author: 'copilot-pull-request-reviewer' },
    { url: COMMENT_LIST[3].html_url, path: 'c.js', author: 'y' },
  ]);
  assert.deepEqual(fake.calls.map((c) => c.key), [THREADS, COMMENTS]);
});

test('review comments are read across every page before the join', async () => {
  const next = `https://api.github.com${R}/pulls/12/comments?per_page=100&page=2`;
  const { gh, fake } = client({
    [THREADS]: { body: CCR_THREADS },
    [COMMENTS]: { body: COMMENT_LIST.slice(0, 2), headers: { link: `<${next}>; rel="next"` } },
    [`GET ${R}/pulls/12/comments?page=2&per_page=100`]: { body: COMMENT_LIST.slice(2) },
  });
  assert.equal((await gh.listUnresolvedThreads(12)).length, 2);
  assert.equal(fake.calls.length, 3);
});

test('no threads and no comments is a real empty result', async () => {
  const { gh } = client({ [THREADS]: { body: [] }, [COMMENTS]: { body: [] } });
  assert.deepEqual(await gh.listUnresolvedThreads(12), []);
});

for (const [name, threads, pattern] of [
  ['an empty thread list while review comments exist', [], /belong to no CCR thread/],
  ['a thread missing one of the comments', CCR_THREADS.slice(0, 2), /belong to no CCR thread/],
  ['a thread naming a comment REST does not have', [...CCR_THREADS, { resolved: false, comment_ids: [99] }], /missing from the REST/],
  ['a malformed thread', [{ comment_ids: [1] }, ...CCR_THREADS.slice(1)], /malformed/],
]) {
  test(`fails closed (GitHubError 422, never zero threads) on ${name}`, async () => {
    const { gh } = client({ [THREADS]: { body: threads }, [COMMENTS]: { body: COMMENT_LIST } });
    await assert.rejects(gh.listUnresolvedThreads(12), (e) => e instanceof GitHubError && e.status === 422 && pattern.test(e.message) && e.message.includes('/ccr/review_threads'));
  });
}

test('a refused CCR route propagates as an error', async () => {
  const { gh } = client({ [THREADS]: { status: 403, body: { message: 'Forbidden' } }, [COMMENTS]: { body: COMMENT_LIST } });
  await assert.rejects(gh.listUnresolvedThreads(12), (e) => e instanceof GitHubError && e.status === 403);
});

test('enableAutoMerge uses PUT …/ccr/auto_merge with a lower-case merge_method', async () => {
  const { gh, fake } = client({ [`PUT ${R}/pulls/5/ccr/auto_merge`]: { body: {} } });
  await gh.enableAutoMerge('PR_5', 'SQUASH', { number: 5 });
  await gh.enableAutoMerge('PR_5', 'merge', { number: 5 });
  assert.deepEqual(fake.calls.map((c) => c.body), [{ merge_method: 'squash' }, { merge_method: 'merge' }]);
  await assert.rejects(gh.enableAutoMerge('PR_5', 'REBASE', { number: 5 }), /SQUASH or MERGE/);
  await assert.rejects(gh.enableAutoMerge('PR_5', 'SQUASH'), /\{ number \} is required/);
  assert.equal(fake.calls.length, 2);
});

test('enableAutoMerge: the route\'s clean-status error keeps the text the driver falls back on', async () => {
  const { gh } = client({ [`PUT ${R}/pulls/5/ccr/auto_merge`]: { status: 422, body: { message: 'Pull request Pull request is in clean status' } } });
  await assert.rejects(gh.enableAutoMerge('PR_5', 'SQUASH', { number: 5 }), (e) => e instanceof GitHubError && /clean status/i.test(e.message));
});

test('disableAutoMerge uses DELETE …/ccr/auto_merge and needs the number', async () => {
  const { gh, fake } = client({ [`DELETE ${R}/pulls/3/ccr/auto_merge`]: { status: 204 } });
  await gh.disableAutoMerge('PR_3', { number: 3 });
  assert.deepEqual(fake.calls.map((c) => c.key), [`DELETE ${R}/pulls/3/ccr/auto_merge`]);
  await assert.rejects(gh.disableAutoMerge('PR_3'), /\{ number \} is required/);
});
