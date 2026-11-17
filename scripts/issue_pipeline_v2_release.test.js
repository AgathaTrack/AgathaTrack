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
    busy: true, dodComplete: true, openLinkedPrs: 1, mergedIntoMain: 2, lastMergeSha: 'bbb',
    lastActivityAt: Date.parse('2026-11-14T00:00:00Z'), resumed: true,
  });
  assert.equal(facts.intentReview.requested, false, 'a non-engine marker does not count');
  assert.deepEqual(facts.prAuthors, ['pawpet-bot', 'pawpet-claude']);
});

test('deployments: newest successful deployment sha; containment by compare', async () => {
  const restFn = async (method, path) => {
    if (path.includes('/statuses')) {
      return path.includes('/deployments/2/') ? [{ state: 'success' }] : [{ state: 'failure' }];
    }
    if (path.includes('/compare/')) {
      return { status: path.includes('old...new') ? 'ahead' : 'diverged' };
    }
    return [{ id: 3, sha: 'bad' }, { id: 2, sha: 'new' }, { id: 1, sha: 'older' }];
  };
  assert.equal(await latestDeploySha({ owner: 'o', repo: 'r', environment: 'UAT', token: 't', restFn }), 'new');
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'old', deploySha: 'new', token: 't', restFn }), true);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'zzz', deploySha: 'new', token: 't', restFn }), false);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'same', deploySha: 'same', token: 't', restFn }), true);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: null, deploySha: 'new', token: 't', restFn }), false);
  assert.equal(await deployContains({ owner: 'o', repo: 'r', mergeSha: 'a', deploySha: 'b', token: 't', restFn: async () => { throw new Error('404'); } }), false);
});

test('resume: one agent restart is recorded even when it fails; no launchable agent stalls', async () => {
  const facts = { mode: 'on', onBoard: true, stage: 'In progress', now: 1e12, deliveryMethod: 'PR', delivery: { busy: false } };
  const action = decide(facts, config);
  assert.deepEqual([action.type, action.agent], ['resume', 'pawpet-bot']);
  assert.equal(decide({ ...facts, deliveryMethod: 'carrier' }, config).type, 'set-blocked');
  const sent = [];
  const ctx = (launchFn) => ({
    owner: 'o', repo: 'r', issueNumber: 7, token: 'p', config, fields: {}, parsed: {}, assignees: [], counters: {}, facts: {}, dryRun: false,
    launchFn, restFn: async (method, path, token, body) => { sent.push(body); return {}; },
  });
  await applyAction({ action, ctx: ctx(async () => ({})) });
  assert.match(sent[0].body, /v2:resume agent=pawpet-bot ok=1/);
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
        fields: { stage: { id: 1, name: 'Stage', options: [] }, blocked: { id: 2, name: 'Blocked', options: [] }, attempts: { id: 3, name: 'Attempts', options: [] }, totalN: { id: 4, name: 'Total N', options: [] } },
        listProjectIssues: async () => [{ issue: { number: 1, state: 'OPEN', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } }],
        getIssue: async () => stageOf(stage),
        listIssueComments: async () => [{ user: { login: 'pawpet-engine' }, body: `<!-- ${INTENT_REVIEW} -->`, created_at: '2026-11-10T00:00:00Z' }],
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
