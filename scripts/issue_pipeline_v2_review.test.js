'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');
const { bodySha } = require('./issue_pipeline_v2_hash');
const { isTrustedRequest } = require('./issue_pipeline_v2_comments');
const {
  buildReviewRequest,
  parseReviewRequest,
  findReviewRequests,
  votesOnRequest,
  deriveReviewFacts,
} = require('./issue_pipeline_v2_review');
const { fetchBodyEdits, fetchCommentEditor } = require('./issue_pipeline_v2_graphql');
const { tick } = require('./issue_pipeline_v2');

const { validateConfig } = require('./issue_pipeline_v2_config');
const limits = loadConfig().limits;
const config = validateConfig({
  agents: [
    { login: 'pawpet-bot', runner: 'cursor', methods: ['PR', 'light-plan', 'execute-plan'] },
    { login: 'pawpet-claude', runner: 'claude', methods: ['PR', 'light-plan'] },
  ],
  engine: { logins: ['engine'] },
  launchRunners: ['cursor'],
  limits,
  aat: { enabled: false, timeoutMin: 120, maxInconclusive: 2 },
});
const prodConfig = { ...loadConfig(), engine: { logins: ['engine'] } };
const NOW = Date.parse('2026-11-16T12:00:00Z');

let nextId = 100;
function request(hash, over = {}) {
  const at = over.at || '2026-11-16T11:00:00Z';
  return {
    id: nextId++,
    node_id: `N${nextId}`,
    user: { login: 'engine' },
    body: buildReviewRequest({ hash, assigned: over.assigned || 'pawpet-claude', history: over.history || [] }),
    created_at: at,
    updated_at: over.updated || at,
  };
}
const reaction = (login, content, at = '2026-11-16T11:10:00Z') => ({ user: { login }, content, created_at: at });
const edit = (editor, editedAt) => ({ editor, editedAt });

function facts(comments, reactionsByComment, edits, over = {}) {
  const derived = deriveReviewFacts({
    comments, reactionsByComment, edits, bodyAuthor: 'KanopeeKa', config, engineLogins: ['engine'], editors: over.editors,
  });
  return { mode: 'dry-run', now: NOW, onBoard: true, stage: 'In analysis', labels: [], bodyHash: over.bodyHash || 'h1', ...derived };
}
const verdict = (f) => decide(f, config);
const verdictBoth = (f) => decide(f, { ...config, launchRunners: ['cursor', 'claude'] });

test('review request: the marker round-trips hash, assignee and history', () => {
  const body = buildReviewRequest({ hash: 'abc123', assigned: 'pawpet-bot', history: ['pawpet-claude'] });
  assert.deepEqual(parseReviewRequest(body), { hash: 'abc123', assigned: 'pawpet-bot', history: ['pawpet-claude'] });
  assert.equal(parseReviewRequest(buildReviewRequest({ hash: 'x' })).assigned, null);
  assert.equal(parseReviewRequest('nothing'), null);
});

test('trust: an engine-authored, unedited request counts; edits by anyone else do not', () => {
  const fresh = request('h1');
  assert.equal(isTrustedRequest(fresh, ['engine'], {}), true);
  const forged = { ...request('h1'), user: { login: 'pawpet-bot' } };
  assert.equal(isTrustedRequest(forged, ['engine'], {}), false);
  const edited = request('h1', { updated: '2026-11-16T11:30:00Z' });
  assert.equal(isTrustedRequest(edited, ['engine'], {}), false, 'unknown editor is not trusted');
  assert.equal(isTrustedRequest(edited, ['engine'], { [edited.node_id]: 'engine' }), true);
  assert.equal(isTrustedRequest(edited, ['engine'], { [edited.node_id]: 'KanopeeKa' }), false);
  assert.equal(findReviewRequests([forged, edited], ['engine'], {}).length, 0);
});

test('votes: reactions are never votes, from any listed agent (PIPE-V2-D-REV4-001)', () => {
  const req = findReviewRequests([request('h1')], ['engine'])[0];
  const votes = votesOnRequest({
    request: req,
    config,
    reactions: [
      reaction('pawpet-bot', '+1', '2026-11-16T11:05:00Z'),
      reaction('pawpet-bot', '-1', '2026-11-16T11:20:00Z'),
      reaction('KanopeeKa', '+1'),
      reaction('pawpet-claude', 'heart'),
      reaction('pawpet-claude', '+1', '2026-11-16T10:00:00Z'),
    ],
  });
  assert.deepEqual(votes, [], 'no reaction counts');
});

test('facts: last editor is the newest editor, else the issue author; edits before In analysis do not count', () => {
  const req = request('h1');
  const before = edit('pawpet-claude', '2026-11-16T09:00:00Z');
  const after = edit('pawpet-bot', '2026-11-16T11:30:00Z');
  const human = edit('KanopeeKa', '2026-11-16T11:40:00Z');
  const none = facts([req], {}, []);
  assert.equal(none.lastBodyEditor, 'KanopeeKa');
  assert.equal(none.totalVotes, 0);
  const some = facts([req], {}, [before, after, human]);
  assert.equal(some.lastBodyEditor, 'KanopeeKa');
  assert.equal(some.totalVotes, 1, 'only the agent edit after the first request counts');
  assert.deepEqual(facts([], {}, []).review, {});
});

test('graphql readers: request shape, ordering, author fallback and unedited comments', async () => {
  const seen = [];
  const graphqlFn = async (token, query, vars) => {
    seen.push([token, vars]);
    if (vars.id) {
      return { node: vars.id === 'edited' ? { lastEditedAt: 'x', editor: { login: 'engine' } } : { lastEditedAt: null, editor: null } };
    }
    return {
      repository: { issue: { author: { login: 'KanopeeKa' }, userContentEdits: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [
        { editedAt: '2026-11-16T10:00:00Z', editor: { login: 'b' } },
        { editedAt: '2026-11-16T09:00:00Z', editor: { login: 'a' } },
      ] } } },
    };
  };
  const result = await fetchBodyEdits({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', graphqlFn });
  assert.deepEqual(result.edits.map((e) => e.editor), ['a', 'b']);
  assert.equal(result.author, 'KanopeeKa');
  assert.deepEqual(seen[0], ['t', { owner: 'o', repo: 'r', number: 5, before: null }]);
  assert.equal(await fetchCommentEditor({ nodeId: 'edited', token: 't', graphqlFn }), 'engine');
  assert.equal(await fetchCommentEditor({ nodeId: 'plain', token: 't', graphqlFn }), null);
  assert.equal(await fetchCommentEditor({ nodeId: '', token: 't', graphqlFn }), null);
});

test('runner: an In analysis issue reads requests, edit history and editors; reactions are not read (signed verdicts only)', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  const body = 'the body';
  const hash = bodySha(body);
  const req = request(hash, { updated: '2026-11-16T11:30:00Z' });
  const calls = [];
  try {
    const result = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config,
        fields: {
          stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] },
          attempts: { id: 3, name: 'Attempts', options: [] },
        },
        listProjectIssues: async () => [{ issue: { number: 7, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
        getIssue: async () => ({
          number: 7, body, labels: [],
          issue_field_values: [{ field_id: 1, single_select_option: { name: 'In analysis' } }, { field_id: 4, value: 0 }],
        }),
        listIssueComments: async () => [req],
        fetchCommentEditor: async ({ nodeId }) => { calls.push(['editor', nodeId]); return 'engine'; },
        listCommentReactions: async ({ commentId }) => { calls.push(['reactions', commentId]); return [reaction('pawpet-bot', '+1')]; },
        fetchBodyEdits: async () => ({ author: 'KanopeeKa', edits: [edit('pawpet-claude', '2026-11-16T11:15:00Z')] }),
      },
    });
    assert.deepEqual(calls, [['editor', req.node_id]], 'reactions are not read: votes are signed verdicts only');
    const entry = result.actions[0];
    // A reaction from a shared login is not a vote (PIPE-V2-D-P2-001), so this silent round is retried.
    assert.equal(entry.action.type, 'reassign', 'a shared-login reaction does not converge the body');
    assert.equal(entry.counters, undefined, 'there is no Total N counter any more');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('graphql: the edit history is paged backwards so edits past one page still count', async () => {
  const seen = [];
  const page = (nodes, hasPreviousPage, startCursor) => ({
    repository: { issue: { author: { login: 'KanopeeKa' }, userContentEdits: { pageInfo: { hasPreviousPage, startCursor }, nodes } } },
  });
  const graphqlFn = async (_token, _query, vars) => {
    seen.push(vars.before);
    if (vars.before === null) {
      return page([{ editedAt: '2026-11-16T12:00:00Z', editor: { login: 'newest' } }], true, 'cursor-1');
    }
    if (vars.before === 'cursor-1') {
      return page([{ editedAt: '2026-11-16T11:00:00Z', editor: { login: 'middle' } }], true, 'cursor-2');
    }
    return page([{ editedAt: '2026-11-16T10:00:00Z', editor: { login: 'oldest' } }], false, null);
  };
  const result = await fetchBodyEdits({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', graphqlFn });
  assert.deepEqual(seen, [null, 'cursor-1', 'cursor-2']);
  assert.deepEqual(result.edits.map((edit) => edit.editor), ['oldest', 'middle', 'newest']);
  // a runaway is bounded
  let calls = 0;
  await fetchBodyEdits({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', maxPages: 3, graphqlFn: async () => { calls += 1; return page([{ editedAt: `2026-11-16T0${calls}:00:00Z`, editor: { login: 'x' } }], true, 'c'); } });
  assert.equal(calls, 3);
});

test('totalVotes: a signed review verdict on an earlier hash still counts toward the vote cap (since entry)', () => {
  const { buildLaunchRecord } = require('./issue_pipeline_v2_launch');
  const T = Date.parse('2026-11-18T10:00:00Z');
  const at = (ms) => new Date(ms).toISOString();
  const nonce = 'd0'.repeat(16);
  const h0 = 'a1'.repeat(8);
  const h1 = 'b2'.repeat(8);
  const engine = 'engine';
  const comments = [
    { id: 1, user: { login: engine }, created_at: at(T), updated_at: at(T), body: buildReviewRequest({ hash: h0, assigned: 'pawpet-claude', history: [], config }) },
    { id: 2, user: { login: engine }, created_at: at(T + 60000), updated_at: at(T + 60000), body: buildLaunchRecord({ runId: 'r1', agent: 'pawpet-claude', purpose: 'doorbell', stage: 'In analysis', nonce }) },
    { id: 3, user: { login: 'pawpet-claude' }, created_at: at(T + 120000), updated_at: at(T + 120000), body: `<!-- v2:verdict agent=pawpet-claude nonce=${nonce} kind=review hash=${h0} value=down -->` },
    { id: 4, user: { login: engine }, created_at: at(T + 180000), updated_at: at(T + 180000), body: buildReviewRequest({ hash: h1, assigned: 'pawpet-bot', history: [], config }) },
  ];
  const facts = deriveReviewFacts({ comments, reactionsByComment: {}, edits: [], bodyAuthor: null, config, engineLogins: [engine], editors: {}, bodyHash: h1, issueNumber: 1, limits, now: T + 240000 });
  assert.equal(facts.totalVotes, 1, 'the down on h0 is a vote cast in In analysis');
});
