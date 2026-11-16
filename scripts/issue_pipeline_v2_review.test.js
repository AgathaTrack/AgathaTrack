'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide } = require('./issue_pipeline_v2_decide');
const { bodySha } = require('./issue_pipeline_state');
const { isTrustedRequest } = require('./issue_pipeline_v2_comments');
const {
  buildReviewRequest,
  parseReviewRequest,
  findReviewRequests,
  votesOnRequest,
  deriveReviewFacts,
  totalNWrite,
} = require('./issue_pipeline_v2_review');
const { fetchBodyEdits, fetchCommentEditor } = require('./issue_pipeline_v2_graphql');
const { tick } = require('./issue_pipeline_v2');

const config = { ...loadConfig(), engine: { logins: ['engine'] } };
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

test('votes: latest 👍/👎 per listed agent; the owner, other emojis and older reactions are ignored', () => {
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
  assert.deepEqual(votes.map(({ login, vote, hash }) => [login, vote, hash]), [['pawpet-bot', 'down', 'h1']]);
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

test('scenario: an agent drafted the spec and one other agent approves → Ready', () => {
  const req = request('h1');
  const f = facts([req], { [req.id]: [reaction('pawpet-bot', '+1')] }, [edit('pawpet-claude', '2026-11-16T10:30:00Z')]);
  const action = verdict(f);
  assert.deepEqual([action.type, action.to, action.evidence.approvedBy], ['set-stage', 'Ready', ['pawpet-bot']]);
});

test('scenario: after a human edit two agents are needed', () => {
  const req = request('h1', { assigned: 'pawpet-bot', at: '2026-11-16T11:50:00Z' });
  const humanEdit = [edit('KanopeeKa', '2026-11-16T11:40:00Z')];
  const at = '2026-11-16T11:55:00Z';
  const one = facts([req], { [req.id]: [reaction('pawpet-claude', '+1', at)] }, humanEdit);
  assert.equal(verdict(one).type, 'none');
  const two = facts([req], { [req.id]: [reaction('pawpet-claude', '+1', at), reaction('pawpet-bot', '+1', at)] }, humanEdit);
  assert.equal(verdict(two).to, 'Ready');
});

test('scenario: a vote on an older hash does not approve the new one, and the new hash is requested', () => {
  const old = request('h0', { at: '2026-11-16T10:00:00Z' });
  const f = facts([old], { [old.id]: [reaction('pawpet-bot', '+1', '2026-11-16T10:10:00Z')] }, [edit('pawpet-claude', '2026-11-16T10:30:00Z')], { bodyHash: 'h1' });
  const action = verdict(f);
  assert.deepEqual([action.type, action.hash, action.agent], ['request-review', 'h1', 'pawpet-bot']);
});

test('scenario: six votes and agent edits without convergence → Blocked no-convergence', () => {
  const r1 = request('h1', { at: '2026-11-16T08:00:00Z' });
  const r2 = request('h2', { at: '2026-11-16T09:00:00Z' });
  const f = facts(
    [r1, r2],
    {
      [r1.id]: [reaction('pawpet-bot', '-1', '2026-11-16T08:10:00Z'), reaction('pawpet-claude', '-1', '2026-11-16T08:20:00Z')],
      [r2.id]: [reaction('pawpet-bot', '-1', '2026-11-16T09:10:00Z')],
    },
    [edit('pawpet-claude', '2026-11-16T08:30:00Z'), edit('pawpet-bot', '2026-11-16T08:40:00Z'), edit('KanopeeKa', '2026-11-16T08:50:00Z'), edit('pawpet-claude', '2026-11-16T09:30:00Z')],
    { bodyHash: 'h2' },
  );
  assert.equal(f.totalVotes, 6, '3 down votes + 3 agent edits; the human edit is not a vote');
  const action = verdict(f);
  assert.deepEqual([action.type, action.reason], ['set-blocked', 'no-convergence']);
});

test('scenario: no vote, every eligible agent timed out → Blocked stalled; one left → reassigned', () => {
  const stale = request('h1', { at: '2026-11-16T10:00:00Z', assigned: 'pawpet-bot', history: [] });
  const oneLeft = verdict(facts([stale], {}, [edit('KanopeeKa', '2026-11-16T09:50:00Z')]));
  assert.deepEqual([oneLeft.type, oneLeft.agent], ['reassign', 'pawpet-claude']);
  const both = request('h1', { at: '2026-11-16T10:00:00Z', assigned: 'pawpet-claude', history: ['pawpet-bot'] });
  const stalled = verdict(facts([both], {}, [edit('KanopeeKa', '2026-11-16T09:50:00Z')]));
  assert.deepEqual([stalled.type, stalled.reason], ['set-blocked', 'stalled']);
});

test('Total N: written only when it differs from the counted votes', () => {
  assert.deepEqual(totalNWrite(3, 3), {});
  assert.deepEqual(totalNWrite(0, 3), { totalN: 3 });
});

test('graphql readers: request shape, ordering, author fallback and unedited comments', async () => {
  const seen = [];
  const graphqlFn = async (token, query, vars) => {
    seen.push([token, vars]);
    if (vars.id) {
      return { node: vars.id === 'edited' ? { lastEditedAt: 'x', editor: { login: 'engine' } } : { lastEditedAt: null, editor: null } };
    }
    return {
      repository: { issue: { author: { login: 'KanopeeKa' }, userContentEdits: { nodes: [
        { editedAt: '2026-11-16T10:00:00Z', editor: { login: 'b' } },
        { editedAt: '2026-11-16T09:00:00Z', editor: { login: 'a' } },
      ] } } },
    };
  };
  const result = await fetchBodyEdits({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', graphqlFn });
  assert.deepEqual(result.edits.map((e) => e.editor), ['a', 'b']);
  assert.equal(result.author, 'KanopeeKa');
  assert.deepEqual(seen[0], ['t', { owner: 'o', repo: 'r', number: 5 }]);
  assert.equal(await fetchCommentEditor({ nodeId: 'edited', token: 't', graphqlFn }), 'engine');
  assert.equal(await fetchCommentEditor({ nodeId: 'plain', token: 't', graphqlFn }), null);
  assert.equal(await fetchCommentEditor({ nodeId: '', token: 't', graphqlFn }), null);
});

test('runner: an In analysis issue reads requests, reactions, edit history and editors', async () => {
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
          attempts: { id: 3, name: 'Attempts', options: [] }, totalN: { id: 4, name: 'Total N', options: [] },
        },
        listProjectIssues: async () => [{ issue: { number: 7, state: 'OPEN', repository: { name: 'AgathaTrack' } } }],
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
    assert.deepEqual(calls, [['editor', req.node_id], ['reactions', req.id]]);
    const entry = result.actions[0];
    assert.deepEqual([entry.action.type, entry.action.to], ['set-stage', 'Ready']);
    assert.deepEqual(entry.counters, { totalN: 2 }, 'one vote plus one agent edit');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});
