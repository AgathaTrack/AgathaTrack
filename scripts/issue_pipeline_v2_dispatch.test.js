'use strict';

// #2553 P4: manual dispatch of issue-pipeline-v2 previews by default, writes only on an explicit
// live request, and validates its issue filter before any board read or write.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveDispatchTarget, resolveRunMode, validatePipelineDispatch } = require('./issue_pipeline_v2_dispatch');

test('issue filter: empty is the whole board; a positive integer targets one issue', () => {
  assert.deepEqual(resolveDispatchTarget(undefined), { ok: true, only: null });
  assert.deepEqual(resolveDispatchTarget(''), { ok: true, only: null });
  assert.deepEqual(resolveDispatchTarget('   '), { ok: true, only: null });
  assert.deepEqual(resolveDispatchTarget('2553'), { ok: true, only: 2553 });
  assert.deepEqual(resolveDispatchTarget(' 12 '), { ok: true, only: 12 });
});

test('issue filter: text, zero, negative, decimal and mixed input are refused, never read as the whole board', () => {
  for (const bad of ['abc', '0', '00', '-3', '1.5', '7x', '1e3', '#2553', '9007199254740993']) {
    const result = resolveDispatchTarget(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.match(result.reason, /positive integer/);
  }
});

test('mode: a manual dispatch previews unless it explicitly asks for live', () => {
  assert.deepEqual(resolveRunMode({ eventName: 'workflow_dispatch', liveRequested: false, repoMode: 'on' }).mode, 'dry-run');
  assert.deepEqual(resolveRunMode({ eventName: 'workflow_dispatch', liveRequested: false, repoMode: 'dry-run' }).mode, 'dry-run');
  assert.equal(resolveRunMode({ eventName: 'workflow_dispatch', liveRequested: false, repoMode: 'on' }).source, 'dispatch-preview');
});

test('mode: a live dispatch writes only when the repo switch is on; otherwise it is downgraded to a preview', () => {
  assert.equal(resolveRunMode({ eventName: 'workflow_dispatch', liveRequested: true, repoMode: 'on' }).mode, 'on');
  assert.equal(resolveRunMode({ eventName: 'workflow_dispatch', liveRequested: true, repoMode: 'dry-run' }).mode, 'dry-run');
  assert.equal(resolveRunMode({ eventName: 'workflow_dispatch', liveRequested: true, repoMode: 'off' }).mode, 'off');
});

test('mode: scheduled ticks keep the repo switch unchanged', () => {
  assert.equal(resolveRunMode({ eventName: 'schedule', liveRequested: false, repoMode: 'on' }).mode, 'on');
  assert.equal(resolveRunMode({ eventName: 'schedule', liveRequested: false, repoMode: 'dry-run' }).mode, 'dry-run');
  assert.equal(resolveRunMode({ eventName: 'schedule', liveRequested: false, repoMode: 'off' }).mode, 'off');
});

test('validatePipelineDispatch: analyse without issue_number is refused', () => {
  assert.equal(validatePipelineDispatch({ issueNumberRaw: '', missionRaw: 'analyse' }).ok, false);
  const ok = validatePipelineDispatch({ issueNumberRaw: '2631', missionRaw: 'analyse' });
  assert.equal(ok.ok, true);
  assert.equal(ok.only, 2631);
  assert.equal(ok.mission, 'analyse');
});

test('entry point: mission=analyse without issue_number exits before board read', () => {
  const script = path.join(__dirname, 'issue_pipeline_v2.js');
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: process.env.PATH,
      ISSUE_PIPELINE_V2: 'on',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      ISSUE_NUMBER: '',
      PIPELINE_V2_MISSION: 'analyse',
      GH_PROJECTS_PAT: 'x',
      GH_PROJECT_ID: 'x',
      GH_STATUS_FIELD_ID: 'x',
      GITHUB_TOKEN: 'x',
    },
  });
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, /pipeline_v2_tick/, 'no board tick');
  assert.match(run.stderr, /requires a positive issue_number/);
});

test('entry point: an invalid issue filter exits non-zero before any board read or write', () => {
  const script = path.join(__dirname, 'issue_pipeline_v2.js');
  const run = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: process.env.PATH,
      ISSUE_PIPELINE_V2: 'on',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      ISSUE_NUMBER: 'abc',
      GH_PROJECTS_PAT: 'x',
      GH_PROJECT_ID: 'x',
      GH_STATUS_FIELD_ID: 'x',
      GITHUB_TOKEN: 'x',
    },
  });
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout, /pipeline_v2_tick|pipeline_v2_action|pipeline_v2_run/, 'no tick, no board decisions');
  assert.match(run.stderr, /issue_number must be a positive integer/);
});
