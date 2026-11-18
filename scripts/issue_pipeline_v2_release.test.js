'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  linksIssue, listLinkedPrs, dodComplete, deriveDeliveryFacts, latestDeploySha, deployContains, buildResume, RESUME, INTENT_REVIEW,
} = require('./issue_pipeline_v2_release');
const { applyAction } = require('./issue_pipeline_v2_apply');
const { decide } = require('./issue_pipeline_v2_decide');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { tick } = require('./issue_pipeline_v2');

const config = loadConfig();
const engine = ['pawpet-engine'];

test('a PR links an issue only with a keyword and the exact number', () => {
  assert.equal(linksIssue('Refs #2385', 2385), true);
  assert.equal(linksIssue('closes #2385.', 2385), true);
  assert.equal(linksIssue('Refs #23850', 2385), false);
  assert.equal(linksIssue('see #2385', 2385), false);
});

test('linked PRs come from timeline cross-references, filtered by the body link', async () => {
  const pulls = {
    11: { state: 'closed', merged: true, merged_at: '2026-11-10T10:00:00Z', merge_commit_sha: 'aaa', base: { ref: 'main' }, user: { login: 'pawpet-bot' }, body: 'Refs #5', updated_at: '2026-11-10T10:00:00Z' },
    12: { state: 'open', merged: false, base: { ref: 'main' }, user: { login: 'pawpet-claude' }, body: 'unrelated mention of #5', updated_at: '2026-11-11T10:00:00Z' },
    13: { state: 'open', merged: false, base: { ref: 'integration' }, user: { login: 'pawpet-claude' }, body: 'Closes #5', updated_at: '2026-11-12T10:00:00Z' },
  };
  const calls = [];
  const restFn = async (method, path) => {
    calls.push(path);
    if (path.includes('/timeline')) {
      return [
        { event: 'cross-referenced', source: { issue: { number: 11, pull_request: {}, repository: { name: 'r', owner: { login: 'o' } } } } },
        { event: 'cross-referenced', source: { issue: { number: 12, pull_request: {}, repository: { name: 'r', owner: { login: 'o' } } } } },
        { event: 'cross-referenced', source: { issue: { number: 13, pull_request: {}, repository: { name: 'r', owner: { login: 'o' } } } } },
        { event: 'cross-referenced', source: { issue: { number: 14, pull_request: {}, repository: { name: 'other', owner: { login: 'o' } } } } },
        { event: 'cross-referenced', source: { issue: { number: 15, repository: { name: 'r', owner: { login: 'o' } } } } },
        { event: 'labeled' },
      ];
    }
    return pulls[Number(path.split('/').pop())];
  };
  const prs = await listLinkedPrs({ owner: 'o', repo: 'r', issueNumber: 5, token: 't', restFn });
  assert.deepEqual(prs.map((pr) => pr.number), [11, 13]);
  assert.equal(calls.filter((path) => path.includes('/pulls/')).length, 3, 'other repo and plain issues are not fetched');
});

test('definition of done: only the checklist sections count, no boxes means complete', () => {
  assert.equal(dodComplete('### Definition of done\n- [x] a\n- [x] b'), true);
  assert.equal(dodComplete('### Definition of done\n- [x] a\n- [ ] b'), false);
  assert.equal(dodComplete('### Checklist\n* [ ] a'), false);
  assert.equal(dodComplete('### Notes\n- [ ] not a gate\n### Definition of done\n- [x] a'), true);
  assert.equal(dodComplete('no boxes'), true);
});

test('delivery facts: merges into main, open PRs, activity ignores the engine, markers are engine-only', () => {
  const prs = [
    { number: 1, state: 'closed', merged: true, mergedAt: '2026-11-10T00:00:00Z', mergeSha: 'aaa', base: 'main', author: 'pawpet-bot', updatedAt: '2026-11-10T00:00:00Z' },
    { number: 2, state: 'closed', merged: true, mergedAt: '2026-11-12T00:00:00Z', mergeSha: 'bbb', base: 'main', author: 'pawpet-claude', updatedAt: '2026-11-12T00:00:00Z' },
    { number: 3, state: 'closed', merged: true, mergedAt: '2026-11-13T00:00:00Z', mergeSha: 'ccc', base: 'integration', author: 'pawpet-bot', updatedAt: '2026-11-13T00:00:00Z' },
    { number: 4, state: 'open', merged: false, base: 'main', author: 'x', updatedAt: '2026-11-11T00:00:00Z' },
  ];
  const comments = [
    { user: { login: 'pawpet-engine' }, body: `<!-- ${RESUME} agent=a ok=1 -->`, created_at: '2026-11-20T00:00:00Z' },
    { user: { login: 'someone' }, body: `<!-- ${INTENT_REVIEW} -->`, created_at: '2026-11-14T00:00:00Z' },
  ];
  const facts = deriveDeliveryFacts({ issue: { body: '- [ ] x', labels: [{ name: 'busy' }] }, prs, comments, engineLogins: engine });
  assert.deepEqual(facts.delivery, {
    busy: true, dodComplete: true, openLinkedPrs: 1, mergedIntoMain: 2, mergedPrNumbers: [1, 2], lastMergeSha: 'bbb',
    lastActivityAt: Date.parse('2026-11-14T00:00:00Z'), resumed: true, engineLaunched: false,
  });
  assert.equal(facts.intentReview.requested, false, 'a non-engine marker does not count');
  assert.deepEqual(facts.prAuthors, ['pawpet-bot', 'pawpet-claude']);
});

test('deploy lookup: the newest successful run of the deploy workflow, never environment records', async () => {
  const seen = [];
  const restFn = async (method, path) => {
    seen.push(path);
    if (path.includes('/compare/')) {
      return { status: path.includes('old...new') ? 'ahead' : 'diverged' };
    }
    return { workflow_runs: [{ head_sha: 'new' }] };
  };
  assert.equal(await latestDeploySha({ owner: 'o', repo: 'r', environment: 'UAT', token: 't', restFn }), 'new');
  assert.match(seen[0], /actions\/workflows\/deploy-uat\.yml\/runs\?status=success&branch=main&per_page=1/);
  await latestDeploySha({ owner: 'o', repo: 'r', environment: 'PROD', token: 't', restFn });
  assert.match(seen[1], /deploy-prod\.yml/);
  assert.equal(await latestDeploySha({ owner: 'o', repo: 'r', environment: 'UAT', token: 't', restFn: async () => ({ workflow_runs: [] }) }), null);
  await assert.rejects(latestDeploySha({ owner: 'o', repo: 'r', environment: 'STAGING', token: 't', restFn }), /No deploy workflow/);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'old', deploySha: 'new', token: 't', restFn }), true);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'zzz', deploySha: 'new', token: 't', restFn }), false);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'same', deploySha: 'same', token: 't', restFn }), true);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: null, deploySha: 'new', token: 't', restFn }), false);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'a', deploySha: 'b', token: 't', restFn: async () => { throw new Error('404'); } }), false);
});

test('resume: one agent restart is recorded even when it fails; no launchable agent stalls', async () => {
  const facts = { mode: 'on', onBoard: true, stage: 'In progress', now: 1e12, deliveryMethod: 'PR', delivery: { busy: false, engineLaunched: true } };
  const action = decide(facts, config);
  assert.deepEqual([action.type, action.agent], ['resume', 'cursor-a']);
  assert.equal(decide({ ...facts, deliveryMethod: 'carrier' }, config).type, 'set-blocked');
  const sent = [];
  const ctx = (launchFn) => ({
    owner: 'o', repo: 'r', issueNumber: 7, token: 'p', config, fields: {}, parsed: {}, assignees: [], counters: {}, facts: {}, dryRun: false,
    launchFn, restFn: async (method, path, token, body) => { sent.push(body); return {}; },
  });
  await applyAction({ action, ctx: ctx(async () => ({})) });
  assert.match(sent[0].body, /v2:resume agent=cursor-a ok=1/);
  await applyAction({ action, ctx: ctx(async () => { throw new Error('down'); }) });
  assert.match(sent[1].body, /ok=0/);
  assert.match(buildResume({ agent: 'a', ok: true }), /ok=1/);
});

test('runner: release stages read PRs and deploys; In Main waits for UAT, In UAT for prod', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  try {
    const stageOf = (name) => ({ number: 1, body: '', labels: [], issue_field_values: [{ field_id: 1, single_select_option: { name } }] });
    const run = async (stage, io) => (await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config: { ...config, engine: { logins: ['pawpet-engine'] } },
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => [{ issue: { number: 1, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
        getIssue: async () => stageOf(stage),
        listIssueComments: async () => [{ user: { login: 'pawpet-engine' }, body: `<!-- ${INTENT_REVIEW} agent=a merge=m1 -->`, created_at: '2026-11-10T00:00:00Z' }],
        listLinkedPrs: async () => [{ number: 1, state: 'closed', merged: true, mergedAt: '2026-11-10T00:00:00Z', mergeSha: 'm1', base: 'main', author: 'pawpet-bot', updatedAt: '2026-11-10T00:00:00Z' }],
        ...io,
      },
    })).actions[0].action;
    assert.equal((await run('In progress', {})).row, 'progress.finished');
    assert.equal((await run('In Main', { deploySha: async () => 'd', deployContains: async () => false })).reason, 'main.waiting-uat');
    assert.equal((await run('In Main', { deploySha: async () => 'd', deployContains: async () => true })).to, 'In UAT');
    assert.equal((await run('In UAT', { deploySha: async () => 'd', deployContains: async () => true })).to, 'Done');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

const { buildIntentReviewRequest, parseFollowUp, followUpDepth } = require('./issue_pipeline_v2_intent');

const merged = (mergeSha, mergedAt) => ({ number: 1, state: 'closed', merged: true, mergedAt, mergeSha, base: 'main', author: 'a', updatedAt: mergedAt });

test('intent review: the request carries the marker the delivery facts read back', () => {
  const body = buildIntentReviewRequest({ agent: 'claude-a', issueNumber: 5, prNumbers: [11, 12], mergeSha: 'abc' });
  assert.match(body, /v2:intent-review agent=claude-a merge=abc/);
  assert.match(body, /#11, #12/);
  assert.match(body, /v2:follow-up of=#5/);
  const facts = deriveDeliveryFacts({
    issue: { body: '', labels: [] }, prs: [merged('abc', '2026-11-10T00:00:00Z')], engineLogins: engine,
    comments: [{ user: { login: 'pawpet-engine' }, body, created_at: '2026-11-10T00:00:00Z' }],
  });
  assert.equal(facts.intentReview.requested, true);
  const later = deriveDeliveryFacts({
    issue: { body: '', labels: [] }, prs: [merged('abc', '2026-11-10T00:00:00Z'), merged('def', '2026-11-12T00:00:00Z')], engineLogins: engine,
    comments: [{ user: { login: 'pawpet-engine' }, body, created_at: '2026-11-10T00:00:00Z' }],
  });
  assert.equal(later.intentReview.requested, false, 'a later merge needs its own review');
});

test('intent review: apply posts the request and rings the agent', async () => {
  const sent = [];
  await applyAction({
    action: { type: 'request-intent-review', agent: 'claude-a' },
    ctx: {
      owner: 'o', repo: 'r', issueNumber: 5, token: 'p', config, fields: {}, parsed: {}, assignees: ['human'], counters: {},
      facts: { delivery: { mergedPrNumbers: [11] }, stage: 'In Main' }, dryRun: false,
      launchFn: async () => ({ runId: 'r' }),
      restFn: async (method, path, token, body) => { sent.push({ path, body }); return {}; },
    },
  });
  assert.match(sent[0].body.body, /v2:intent-review agent=claude-a/);
  assert.deepEqual(sent[1].body.assignees, ['human', 'pawpet-claude']);
});

test('follow-up depth is counted from the parents, bounded, and cycle safe', async () => {
  assert.equal(parseFollowUp('<!-- v2:follow-up of=#7 -->\ntext'), 7);
  assert.equal(parseFollowUp('plain'), null);
  const bodies = { 7: '<!-- v2:follow-up of=#3 -->', 3: 'root', 8: '<!-- v2:follow-up of=#9 -->', 9: '<!-- v2:follow-up of=#8 -->' };
  const getIssue = async (n) => ({ body: bodies[n] });
  assert.equal(await followUpDepth({ body: 'root', getIssue }), 0);
  assert.equal(await followUpDepth({ body: '<!-- v2:follow-up of=#3 -->', getIssue }), 1);
  assert.equal(await followUpDepth({ body: '<!-- v2:follow-up of=#7 -->', getIssue }), 2);
  assert.equal(await followUpDepth({ body: '<!-- v2:follow-up of=#8 -->', getIssue }), 2, 'a cycle stops');
});

test('runner: an empty-stage follow-up goes to To do within depth 2, to Backlog beyond', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  try {
    const bodies = { 10: '<!-- v2:follow-up of=#2 -->', 2: '<!-- v2:follow-up of=#1 -->', 1: 'root', 20: '<!-- v2:follow-up of=#10 -->' };
    const run = async (number) => (await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config,
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => [{ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
        getIssue: async (n) => ({ number: n, body: bodies[n], labels: [], issue_field_values: [] }),
      },
    })).actions[0].action;
    assert.equal((await run(10)).to, 'To do');
    assert.equal((await run(10)).row, 'followup.todo');
    assert.equal((await run(20)).to, 'Backlog', '20 -> 10 -> 2 -> 1 is three deep');
    assert.equal((await run(20)).row, 'followup.too-deep');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('runner: startable agents alternate within a tick, and a scope label limits where `on` writes', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'on';
  try {
    const todo = (number, label) => ({ number, body: '', labels: label ? [{ name: label }] : [], issue_field_values: [{ field_id: 1, single_select_option: { name: 'To do' } }] });
    const issues = { 1: todo(1, 'pipeline-beta'), 2: todo(2), 3: todo(3, 'pipeline-beta') };
    const board = [1, 2, 3].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }));
    const seen = [];
    const run = (scopeLabel) => tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config: { ...config, launchRunners: ['cursor', 'claude'] },
        scopeLabel,
        checkEngineIdentity: async () => ({ ok: true, login: 'pawpet-engine' }),
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => board,
        getIssue: async (n) => issues[n],
        listIssueComments: async () => [],
        applyAction: async ({ action, ctx: c }) => { seen.push([c.issueNumber, action.agent, c.dryRun]); return { applied: [], calls: [] }; },
      },
    });
    await run('');
    assert.deepEqual(
      seen.map((s) => s[1]),
      ['cursor-a', 'cursor-b', 'claude-a'],
      'least recently used alternates across startable ids',
    );
    assert.deepEqual(seen.map((s) => s[2]), [false, false, false]);
    seen.length = 0;
    await run('pipeline-beta');
    assert.deepEqual(seen.map((s) => [s[0], s[2]]), [[1, false], [2, true], [3, false]], 'only labelled issues are written to');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});

test('engineLaunched: a run record counts, a failed-launch record does not', () => {
  const note = (body, login = 'pawpet-engine') => ({ user: { login }, body, created_at: '2026-11-10T00:00:00Z' });
  const launched = (comments) => deriveDeliveryFacts({ issue: { body: '', labels: [] }, prs: [], comments, engineLogins: engine }).delivery.engineLaunched;
  assert.equal(launched([note('<!-- v2:launch run=r1 agent=pawpet-bot -->')]), true);
  assert.equal(launched([note('<!-- v2:launch-acked run=r1 -->')]), true);
  assert.equal(launched([note('<!-- v2:launch-failed agent=pawpet-bot -->')]), false, 'nothing was started');
  assert.equal(launched([note('<!-- v2:launch run=r1 agent=pawpet-bot -->', 'someone')]), false, 'engine comments only');
  assert.equal(launched([]), false);
});

test('runner: a simulated out-of-scope launch does not take a WIP slot from an in-scope issue', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'on';
  try {
    const field = (name) => [{ field_id: 1, single_select_option: { name } }];
    const issues = {
      1: { number: 1, body: '', labels: [], issue_field_values: field('In progress') },
      10: { number: 10, body: '', labels: [], issue_field_values: field('Ready') },
      11: { number: 11, body: '', labels: [{ name: 'pipeline-beta' }], issue_field_values: field('Ready') },
    };
    const board = [1, 10, 11].map((number) => ({ issue: { number, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }));
    const result = await tick({
      owner: 'AgathaTrack', repo: 'AgathaTrack', token: 't', projectsPat: 'p', projectId: 'P', statusFieldId: 'S',
      io: {
        config,
        scopeLabel: 'pipeline-beta',
        checkEngineIdentity: async () => ({ ok: true, login: 'pawpet-engine' }),
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] } },
        listProjectIssues: async () => board,
        getIssue: async (n) => issues[n],
        listIssueComments: async () => [],
        listLinkedPrs: async () => [],
        applyAction: async ({ action }) => ({ applied: action.type === 'launch' ? [`launch:${action.agent}`] : [], calls: [] }),
      },
    });
    const byIssue = Object.fromEntries(result.actions.map((entry) => [entry.issue, entry.action]));
    assert.equal(byIssue[10].type, 'launch', 'decided and logged');
    assert.equal(byIssue[11].type, 'launch', 'the in-scope issue still gets the free slot (limit 2, one In progress)');
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});
