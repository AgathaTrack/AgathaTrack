#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContext, run } = require('./pr_review_request');
const { CURSOR_REVIEW_MARKER } = require('./lib/pr_review_request_lib');

const ENV = {
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_TOKEN: 'actions-token',
  OWNER_COPILOT_REQUEST_TOKEN: 'owner-token',
  EXECUTE_PLAN_BOT_TOKEN: 'bot-token',
  CURSOR_API_KEY: 'cursor-key',
  PR_REVIEW_WAIT_MIN: '0.001',
  PR_REVIEW_POLL_SEC: '0.01',
};

function pullFixture(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    draft: false,
    html_url: 'https://github.com/o/r/pull/7',
    user: { login: 'pawpet-bot' },
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    head: { ref: 'cursor/x-44e7', sha: 'abc123', repo: { full_name: 'o/r' } },
    requested_reviewers: [],
    ...overrides,
  };
}

/** Routes fetch by "METHOD path" and records calls; `copilotStartsAfter` flips events after N polls. */
function installFetch({ pull = pullFixture(), copilotStartsAfter = Infinity, closeAfter = Infinity, issueComments = [] } = {}) {
  const calls = [];
  let eventPolls = 0;
  let pullPolls = 0;
  const original = global.fetch;
  global.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const { hostname, pathname } = new URL(url);
    const path = pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const auth = init.headers?.Authorization;
    calls.push({ method, hostname, path, body, auth });
    const json = (data, status = 200) => ({ ok: true, status, json: async () => data, text: async () => JSON.stringify(data) });

    if (hostname === 'api.cursor.com') {
      return json({ agent: { id: 'a1', url: 'https://cursor.com/agents/a1' }, run: { id: 'r1' } });
    }
    if (method === 'GET' && path === '/repos/o/r/pulls/7') {
      pullPolls += 1;
      return json(pullPolls > closeAfter ? { ...pull, state: 'closed' } : pull);
    }
    if (method === 'GET' && path === '/user') return json({ login: 'pawpet-bot' });
    if (method === 'GET' && path === '/repos/o/r/issues/7/events') {
      eventPolls += 1;
      return json(eventPolls > copilotStartsAfter ? [{ event: 'copilot_work_started' }] : []);
    }
    if (method === 'GET' && path === '/repos/o/r/issues/7/comments') return json(issueComments);
    if (method === 'GET') return json([]);
    if (method === 'POST' && path === '/repos/o/r/issues/7/comments') return json({ id: 99 }, 201);
    return json({}, 200);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function stateBodies(calls) {
  return calls
    .filter((c) => (c.path.endsWith('/issues/7/comments') && c.method === 'POST') || c.path.includes('/issues/comments/'))
    .map((c) => JSON.parse(c.body.body.match(/<!-- pr-review-request: (.*) -->/)[1]));
}

function stateWrites(calls) {
  return stateBodies(calls).map((state) => state.state);
}

function launches(calls) {
  return calls.filter((c) => c.hostname === 'api.cursor.com');
}

test('buildContext requires repo, PR number and GITHUB_TOKEN', () => {
  assert.throws(() => buildContext({}, {}), /required/);
  assert.throws(() => buildContext({ pr: '7' }, { GITHUB_REPOSITORY: 'o/r' }), /GITHUB_TOKEN/);
  const ctx = buildContext({ pr: '7' }, { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' });
  assert.equal(ctx.model, 'composer-2.5');
  assert.equal(ctx.waitMs, 8 * 60 * 1000);
});

test('requests Copilot with the owner token and stops once Copilot starts', async () => {
  const { calls, restore } = installFetch({ copilotStartsAfter: 1 });
  try {
    await run(buildContext({ pr: '7' }, ENV));
  } finally {
    restore();
  }
  const request = calls.find((c) => c.method === 'POST' && c.path.endsWith('/requested_reviewers'));
  assert.equal(request.auth, 'Bearer owner-token');
  assert.deepEqual(request.body, { reviewers: ['copilot-pull-request-reviewer[bot]'] });
  assert.deepEqual(stateWrites(calls), ['requested', 'copilot']);
  assert.ok(!calls.some((c) => c.hostname === 'api.cursor.com'));
  assert.ok(calls.filter((c) => c.path.includes('/issues/')).every((c) => c.method === 'GET' || c.auth === 'Bearer actions-token'));
});

test('launches the Cursor review agent on the PR head when Copilot never starts', async () => {
  const { calls, restore } = installFetch();
  try {
    await run(buildContext({ pr: '7' }, ENV));
  } finally {
    restore();
  }
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.endsWith('/requested_reviewers')));
  const launch = calls.find((c) => c.hostname === 'api.cursor.com');
  assert.equal(launch.body.model.id, 'composer-2.5');
  assert.equal(launch.body.repos[0].startingRef, 'cursor/x-44e7');
  assert.equal(launch.body.workOnCurrentBranch, false);
  assert.equal(launch.body.envVars.GH_TOKEN, 'bot-token');
  assert.ok(launch.body.prompt.text.includes(CURSOR_REVIEW_MARKER));
  assert.deepEqual(stateWrites(calls), ['requested', 'cursor-launched']);
  const launched = stateBodies(calls).at(-1);
  assert.equal(launched.reviewer_login, 'pawpet-bot');
  assert.ok(launched.launched_at);
});

test('replaces a ruleset Copilot request (made as the unlicensed author) with the owner request', async () => {
  const { calls, restore } = installFetch({
    pull: pullFixture({ requested_reviewers: [{ login: 'Copilot' }] }),
    copilotStartsAfter: 1,
  });
  try {
    await run(buildContext({ pr: '7' }, ENV));
  } finally {
    restore();
  }
  const reviewerCalls = calls.filter((c) => c.path.endsWith('/requested_reviewers')).map((c) => c.method);
  assert.equal(reviewerCalls.at(-1), 'POST');
  assert.ok(reviewerCalls.indexOf('DELETE') < reviewerCalls.indexOf('POST'));
  assert.ok(calls.filter((c) => c.path.endsWith('/requested_reviewers')).every((c) => c.auth === 'Bearer owner-token'));
  assert.deepEqual(stateWrites(calls), ['requested', 'copilot']);
});

test('a PR closed by the post-deadline snapshot gets no withdrawal and no agent', async () => {
  const { calls, restore } = installFetch({ closeAfter: 1 });
  try {
    await run(buildContext({ pr: '7' }, ENV));
  } finally {
    restore();
  }
  assert.ok(!calls.some((c) => c.method === 'DELETE'));
  assert.equal(launches(calls).length, 0);
  assert.deepEqual(stateWrites(calls), ['requested']);
});

test('skips PRs that are not agent-authored and PRs already handled', async () => {
  let fx = installFetch({ pull: pullFixture({ user: { login: 'KanopeeKa' } }) });
  try {
    await run(buildContext({ pr: '7' }, ENV));
  } finally {
    fx.restore();
  }
  assert.ok(!fx.calls.some((c) => c.method !== 'GET'));

  const handled = [{ id: 5, user: { login: 'github-actions[bot]' }, body: '<!-- pr-review-request: {"state":"cursor-launched"} -->' }];
  fx = installFetch({ issueComments: handled });
  try {
    await run(buildContext({ pr: '7' }, ENV));
  } finally {
    fx.restore();
  }
  assert.ok(!fx.calls.some((c) => c.method !== 'GET'));
});

test('without an owner token, goes straight to the Cursor fallback', async () => {
  const { calls, restore } = installFetch();
  try {
    await run(buildContext({ pr: '7' }, { ...ENV, OWNER_COPILOT_REQUEST_TOKEN: '' }));
  } finally {
    restore();
  }
  assert.ok(!calls.some((c) => c.path.endsWith('/requested_reviewers')));
  assert.deepEqual(stateWrites(calls), ['cursor-launched']);
});

test('without a Cursor key either, records the review as unavailable', async () => {
  const { calls, restore } = installFetch();
  try {
    await run(buildContext({ pr: '7' }, { ...ENV, OWNER_COPILOT_REQUEST_TOKEN: '', CURSOR_API_KEY: '' }));
  } finally {
    restore();
  }
  assert.deepEqual(stateWrites(calls), ['unavailable']);
});
