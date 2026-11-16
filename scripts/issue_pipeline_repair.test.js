'use strict';

// Regression tests for the #2363 review findings (real request shapes, not recorder mocks).
const test = require('node:test');
const assert = require('node:assert/strict');

const lib = require('../.github/scripts/github-project-lib');
const { loadIssueState, upsertPipelineState } = require('./issue_pipeline_state_load');
const { decideReopen, buildReopenState, applyReviewStub } = require('./issue_pipeline_review');
const { untrustedStateSkipReason, isOwnerBodyEdit } = require('./issue_pipeline_guards');
const { findTrustedRunMarker, isStubRunMarker } = require('./lib/pipeline_run_marker');
const { applyImplementLaunch } = require('./issue_pipeline_implement');
const { applyMonitorTick } = require('./issue_pipeline_monitor');
const { tick } = require('./issue_pipeline_dispatcher');
const {
  parseTrustedMergeCommitFromComments,
  deployContainsMergeCommit,
  parseLinkedIssues,
} = require('../.github/scripts/issue-agent-handlers');

const stateBody = (s, marker = true) =>
  `${marker ? '<!-- pipeline-state -->\n' : ''}<!-- agent-state: ${JSON.stringify(s)} -->`;

test('setIssueAssignees uses PATCH on the issue (assignees endpoint has no PUT)', async () => {
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init) => {
    seen.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    await lib.setIssueAssignees('o', 'r', 7, ['pawpet-claude'], 'tok');
    await lib.setIssueAssignees('o', 'r', 7, [], 'tok');
  } finally {
    global.fetch = realFetch;
  }
  assert.equal(seen[0].method, 'PATCH');
  assert.match(seen[0].url, /\/repos\/o\/r\/issues\/7$/);
  assert.deepEqual(seen[0].body, { assignees: ['pawpet-claude'] });
  assert.deepEqual(seen[1].body, { assignees: [] });
});

test('state load: legacy lane comment migrates, forged marker never does', async () => {
  const io = {
    fetchAllIssueComments: async () => [
      { id: 1, user: { login: 'evil' }, body: stateBody({ round: 9 }), updated_at: '2026-11-16T10:00:00Z' },
      { id: 2, user: { login: 'pawpet-bot' }, body: stateBody({ round: 2 }, false), updated_at: '2026-11-16T09:00:00Z' },
    ],
  };
  const r = await loadIssueState('o', 'r', 1, 't', io);
  assert.equal(r.source, 'legacy');
  assert.equal(r.state.round, 2);
});

test('state load: dedicated comment edited by someone else is rejected, not replaced by legacy', async () => {
  const io = {
    fetchAllIssueComments: async () => [
      { id: 1, node_id: 'N1', user: { login: 'pawpet-bot' }, body: stateBody({ round: 1 }), updated_at: '2026-11-16T10:00:00Z' },
      { id: 2, user: { login: 'pawpet-bot' }, body: stateBody({ round: 5 }, false), updated_at: '2026-11-16T11:00:00Z' },
    ],
    fetchCommentEditor: async () => 'KanopeeKa',
  };
  const r = await loadIssueState('o', 'r', 1, 't', io);
  assert.equal(r.source, 'rejected');
  assert.equal(r.state.round, 0);
  assert.equal(untrustedStateSkipReason('In Analysis', r.source), 'untrusted-pipeline-state');
  assert.equal(untrustedStateSkipReason('To do', r.source), null);
  assert.equal(untrustedStateSkipReason('Ready', 'none'), 'no-pipeline-state');
});

test('state write fails closed without the bot token and only edits trusted comments', async () => {
  await assert.rejects(
    upsertPipelineState({ owner: 'o', repo: 'r', issueNumber: 1, assignToken: undefined, state: {} }),
    /EXECUTE_PLAN_BOT_TOKEN/,
  );
  let args;
  await upsertPipelineState({
    owner: 'o', repo: 'r', issueNumber: 1, assignToken: 'bot', state: { round: 1 },
    io: { upsertMarkerComment: async (a) => { args = a; } },
  });
  assert.equal(args.token, 'bot');
  assert.equal(args.match({ user: { login: 'evil' } }), false);
  assert.equal(args.match({ user: { login: 'pawpet-claude' } }), true);
});

test('reopen: keeps last_assignee so the new assignee can review', () => {
  const state = { round: 2, last_assignee: 'pawpet-claude', converged_at: 'x', verdicts: { a: 'green' } };
  const d = decideReopen({ state, ownerEdited: false });
  assert.equal(d.assignee, 'pawpet-bot');
  const next = buildReopenState(state, 'sha', d.round);
  assert.equal(next.last_assignee, 'pawpet-claude');
  assert.notEqual(next.last_assignee, d.assignee);
  assert.equal(next.round, 3);
  assert.deepEqual(next.verdicts, {});
});

test('reopen: owner edit resets round, agent reopen at the cap goes to needs-owner', () => {
  assert.equal(decideReopen({ state: { round: 4, last_assignee: 'pawpet-bot' }, ownerEdited: true }).round, 0);
  const cap = decideReopen({ state: { round: 5, last_assignee: 'pawpet-bot' }, ownerEdited: false });
  assert.equal(cap.kind, 'needs-owner');
  assert.equal(cap.owner_reason, 'no-convergence-reopen');
});

test('owner edit detection needs the owner as editor and a newer edit than the state', () => {
  const edit = { editor: 'KanopeeKa', editedAt: '2026-11-16T12:00:00Z' };
  assert.equal(isOwnerBodyEdit(edit, '2026-11-16T11:00:00Z'), true);
  assert.equal(isOwnerBodyEdit(edit, '2026-11-16T13:00:00Z'), false);
  assert.equal(isOwnerBodyEdit({ ...edit, editor: 'pawpet-bot' }, '2026-11-16T11:00:00Z'), false);
  assert.equal(isOwnerBodyEdit({ ...edit, editor: null }, '2026-11-16T11:00:00Z'), false);
  assert.equal(isOwnerBodyEdit(null, '2026-11-16T11:00:00Z'), false);
});

test('a Green without an agent-paths block is recorded as Red', async () => {
  process.env.PIPELINE_REVIEW_VERDICT = 'green';
  try {
    const run = (body) =>
      applyReviewStub({
        state: { round: 1, last_assignee: 'pawpet-bot', verdicts: { 'pawpet-bot': 'green' }, body_sha: 's' },
        liveBodySha: 's', reviewer: 'pawpet-claude', dryRun: true, body,
      });
    const noPaths = await run('no block');
    assert.equal(noPaths.missingPaths, true);
    assert.equal(noPaths.plan.kind, 'continue-analysis');
    const withPaths = await run('```agent-paths\n{"globs":["docs/**"]}\n```');
    assert.equal(withPaths.plan.kind, 'converged');
  } finally {
    delete process.env.PIPELINE_REVIEW_VERDICT;
  }
});

test('run marker: only trusted authors, newest wins, stub detected', () => {
  const marker = (o) => `<!-- cursor-agent-run: ${JSON.stringify(o)} -->`;
  const found = findTrustedRunMarker([
    { user: { login: 'evil' }, body: marker({ agentId: 'x', runId: 'y', status: 'running' }), updated_at: '2026-11-16T12:00:00Z' },
    { user: { login: 'pawpet-bot' }, body: marker({ agentId: 'a', runId: 'b', status: 'running' }), updated_at: '2026-11-16T10:00:00Z' },
  ]);
  assert.equal(found.marker.agentId, 'a');
  assert.equal(findTrustedRunMarker([{ body: marker({ agentId: 'a' }) }]), null);
  assert.equal(isStubRunMarker({ agentId: 'pipeline-stub' }), true);
});

test('monitor releases the slot when there is no run marker at all', async () => {
  const labels = [];
  const lib2 = require('../.github/scripts/github-project-lib');
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (init.method === 'GET' && /comments/.test(url)) {
      return { ok: true, status: 200, json: async () => [] };
    }
    labels.push({ method: init.method, url, body: init.body });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  try {
    const r = await applyMonitorTick({ owner: 'o', repo: 'r', issueNumber: 3, token: 't', dryRun: false });
    assert.equal(r.released, true);
    assert.equal(r.reason, 'missing-run-marker');
  } finally {
    global.fetch = origFetch;
  }
  assert.ok(lib2);
});

function implementIo(overrides = {}) {
  const calls = [];
  const io = {
    fetchIssue: async () => ({
      number: 5, title: 't', url: 'u',
      body: '```agent-paths\n{"globs":["docs/**"]}\n```',
      labels: { nodes: [{ name: 'PR' }] },
    }),
    listTrackedFiles: () => ['docs/a.md'],
    fetchAllIssueComments: async () => [],
    launchAgent: async () => ({ agent: { id: 'ag1', url: 'u' }, run: { id: 'run1' } }),
    upsertMarkerComment: async () => calls.push('marker'),
    assignIssue: async () => calls.push('assign'),
    setLabels: async () => calls.push('labels'),
    updateProjectStatus: async () => calls.push('status'),
    ...overrides,
  };
  return { io, calls };
}

test('implement: launch failure leaves the issue queued with no writes', async () => {
  process.env.PIPELINE_IMPLEMENT_LAUNCH = 'true';
  process.env.CURSOR_API_KEY = 'k';
  try {
    const { io, calls } = implementIo({ launchAgent: async () => { throw new Error('boom'); } });
    const r = await applyImplementLaunch({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', dryRun: false, io });
    assert.equal(r.reason, 'launch-failed');
    assert.equal(r.status, 'Ready');
    assert.deepEqual(calls, []);
  } finally {
    delete process.env.PIPELINE_IMPLEMENT_LAUNCH;
    delete process.env.CURSOR_API_KEY;
  }
});

test('implement: run marker is written before handoff; a later failure resumes, never relaunches', async () => {
  process.env.PIPELINE_IMPLEMENT_LAUNCH = 'true';
  process.env.CURSOR_API_KEY = 'k';
  try {
    const order = [];
    let launches = 0;
    const first = implementIo({
      launchAgent: async () => { launches += 1; return { agent: { id: 'ag1' }, run: { id: 'run1' } }; },
      upsertMarkerComment: async () => order.push('marker'),
      assignIssue: async () => { order.push('assign'); throw new Error('api down'); },
    });
    await assert.rejects(
      applyImplementLaunch({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', dryRun: false, io: first.io }),
      /api down/,
    );
    assert.deepEqual(order, ['marker', 'assign']);

    const marker = `<!-- cursor-agent-run: ${JSON.stringify({ agentId: 'ag1', runId: 'run1', status: 'running' })} -->`;
    const second = implementIo({
      launchAgent: async () => { launches += 1; return {}; },
      fetchAllIssueComments: async () => [{ user: { login: 'pawpet-bot' }, body: marker, updated_at: '2026-11-16T10:00:00Z' }],
    });
    const r = await applyImplementLaunch({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', dryRun: false, io: second.io });
    assert.equal(r.resumed, 'run1');
    assert.equal(launches, 1);
    assert.deepEqual(second.calls, ['assign', 'labels']);
  } finally {
    delete process.env.PIPELINE_IMPLEMENT_LAUNCH;
    delete process.env.CURSOR_API_KEY;
  }
});

test('prod notify: ancestry direction, authorless comments, Refs', async () => {
  const sha = 'a'.repeat(40);
  const c = (user) => ({ user, body: `<!-- agent-uat-branch -->\nMerge commit: \`${sha}\``, updated_at: 't' });
  assert.equal(parseTrustedMergeCommitFromComments([c(undefined)]), null);
  assert.equal(parseTrustedMergeCommitFromComments([c({ login: 'github-actions[bot]' })]), null);
  assert.equal(parseTrustedMergeCommitFromComments([c({ login: 'pawpet-bot' })]), sha);

  const cmp = (status) => async () => ({ status });
  const deploy = 'b'.repeat(40);
  assert.equal(await deployContainsMergeCommit('o', 'r', sha, deploy, 't', cmp('ahead')), true);
  assert.equal(await deployContainsMergeCommit('o', 'r', sha, deploy, 't', cmp('behind')), false);
  assert.equal(await deployContainsMergeCommit('o', 'r', sha, deploy, 't', cmp('diverged')), false);

  assert.deepEqual(parseLinkedIssues('Refs #5\nCloses #6', { includeRefs: false }), [6]);
  assert.deepEqual(parseLinkedIssues('Refs #5\nCloses #6'), [5, 6]);
});

test('scoped tick counts WIP over the whole board and launches nothing at the limit', async () => {
  const board = [
    { number: 1, title: 'a', body: '', labels: [], status: 'In progress', assignees: ['pawpet-bot'] },
    { number: 2, title: 'b', body: '', labels: [], status: 'In progress', assignees: ['pawpet-bot'] },
    { number: 3, title: 'c', body: 'x', labels: ['PR'], status: 'Ready', assignees: [] },
  ];
  const r = await tick({
    owner: 'o', repo: 'r', token: 't', issueNumber: 3, mode: 'dry-run',
    io: {
      projectSecrets: { projectsPat: 'p', projectId: 'P', statusFieldId: 'S' },
      assertPipelineStatusOptions: async () => [],
      fetchPipelineIssueForProject: async () => board[2],
      listPipelineIssues: async () => board,
      loadIssueState: async () => ({
        state: { converged_at: 'x', body_sha: require('./issue_pipeline_state').bodySha('x') },
        source: 'pipeline-state',
      }),
    },
  });
  assert.equal(r.wipInUse, 2);
  assert.equal(r.actions.filter((a) => a.action === 'implement-launch').length, 0);
});
