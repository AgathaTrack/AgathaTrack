'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pipelineV2Mode, labelNames, v2Owns, v2OwnsLazy } = require('./pipeline-v2-owner');

test('mode reads ISSUE_PIPELINE_V2 and anything unknown is off', () => {
  assert.equal(pipelineV2Mode({}), 'off');
  assert.equal(pipelineV2Mode({ ISSUE_PIPELINE_V2: ' On ' }), 'on');
  assert.equal(pipelineV2Mode({ ISSUE_PIPELINE_V2: 'dry-run' }), 'dry-run');
  assert.equal(pipelineV2Mode({ ISSUE_PIPELINE_V2: 'yes' }), 'off');
});

test('labelNames accepts GraphQL nodes, REST labels and plain lists', () => {
  assert.deepEqual(labelNames({ labels: { nodes: [{ name: 'a' }] } }), ['a']);
  assert.deepEqual(labelNames({ labels: [{ name: 'b' }, 'c'] }), ['b', 'c']);
  assert.deepEqual(labelNames(['d']), ['d']);
  assert.deepEqual(labelNames({}), []);
});

test('the engine owns an issue only in `on`, and only labelled issues when a scope label is set', () => {
  assert.equal(v2Owns({ labels: [], env: {} }), false);
  assert.equal(v2Owns({ labels: [], env: { ISSUE_PIPELINE_V2: 'dry-run' } }), false, 'dry-run writes nothing, so legacy keeps working');
  assert.equal(v2Owns({ labels: [], env: { ISSUE_PIPELINE_V2: 'on' } }), true, 'whole board');
  const scoped = { ISSUE_PIPELINE_V2: 'on', ISSUE_PIPELINE_V2_LABEL: 'pipeline-beta' };
  assert.equal(v2Owns({ labels: ['pipeline-beta'], env: scoped }), true);
  assert.equal(v2Owns({ labels: ['task'], env: scoped }), false);
});

test('labels are fetched only when a scope label makes them matter', async () => {
  let fetched = 0;
  const getLabels = async () => {
    fetched += 1;
    return ['pipeline-beta'];
  };
  assert.equal(await v2OwnsLazy({ getLabels, env: {} }), false);
  assert.equal(await v2OwnsLazy({ getLabels, env: { ISSUE_PIPELINE_V2: 'on' } }), true);
  assert.equal(fetched, 0);
  assert.equal(await v2OwnsLazy({ getLabels, env: { ISSUE_PIPELINE_V2: 'on', ISSUE_PIPELINE_V2_LABEL: 'pipeline-beta' } }), true);
  assert.equal(fetched, 1);
});

const { inEngineScope } = require('./pipeline-v2-owner');

test('only the Pawpet board and the engine repository are in the engine scope', () => {
  const env = { GITHUB_REPOSITORY: 'AgathaTrack/AgathaTrack' };
  assert.equal(inEngineScope({ boardKey: 'pawpet', issueRepoSlug: 'AgathaTrack/AgathaTrack', env }), true);
  assert.equal(inEngineScope({ boardKey: 'pawpet', issueRepoSlug: 'agathatrack/agathatrack', env }), true, 'case-insensitive');
  assert.equal(inEngineScope({ boardKey: 'atsupport', issueRepoSlug: 'AgathaTrack/AgathaTrack', env }), false);
  assert.equal(inEngineScope({ boardKey: 'pawpet', issueRepoSlug: 'AgathaTrack/AgathaTrackPrivate', env }), false);
  assert.equal(inEngineScope({ boardKey: 'pawpet', issueRepoSlug: 'AgathaTrack/AgathaTrack', env: {}, defaultRepoSlug: 'AgathaTrack/AgathaTrack' }), true, 'falls back to the board repo');
  assert.equal(inEngineScope({ boardKey: 'pawpet', issueRepoSlug: 'x/y', env: {} }), false);
});
