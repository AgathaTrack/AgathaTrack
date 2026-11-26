'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMission, missionGuard } = require('./issue_pipeline_mission');
const { decide } = require('./issue_pipeline_v2_decide');
const { loadConfig } = require('./issue_pipeline_v2_config');

test('resolveMission: board allows whole-board tick', () => {
  assert.deepEqual(resolveMission({ mission: 'board', issueNumber: null }), { ok: true, mission: 'board' });
  assert.deepEqual(resolveMission({ issueNumber: null }), { ok: true, mission: 'board' });
});

test('resolveMission: analyse requires issue_number', () => {
  assert.equal(resolveMission({ mission: 'analyse', issueNumber: null }).ok, false);
  assert.deepEqual(resolveMission({ mission: 'analyse', issueNumber: 42 }), { ok: true, mission: 'analyse' });
});

test('resolveMission: unknown mission refused', () => {
  assert.equal(resolveMission({ mission: 'deliver', issueNumber: 1 }).ok, false);
});

test('missionGuard: analyse stops at Ready without launch', () => {
  const blocked = missionGuard('Ready', 'analyse');
  assert.equal(blocked?.row, 'mission.analyse.complete');
  assert.equal(missionGuard('In progress', 'analyse')?.row, 'mission.analyse.post-ready');
  assert.equal(missionGuard('To do', 'analyse'), null);
});

const readyFactsBase = () => ({
  mode: 'on',
  onBoard: true,
  labels: [],
  stage: 'Ready',
  blocked: null,
  bodyHash: 'abc',
  wip: 0,
  deliveryMethod: 'PR',
  now: Date.now(),
  closed: false,
  launch: {},
});

test('decide: mission analyse on closed In progress does not reopen', () => {
  const config = loadConfig();
  const action = decide(
    {
      mode: 'on',
      onBoard: true,
      labels: [],
      stage: 'In progress',
      blocked: null,
      closed: true,
      closeReason: 'completed',
      reopenedBefore: false,
      mission: 'analyse',
    },
    config,
  );
  assert.equal(action.row, 'mission.analyse.post-ready');
  assert.notEqual(action.type, 'reopen');
});

test('decide: mission analyse at Ready with engine hold does not release', () => {
  const config = loadConfig();
  const action = decide(
    {
      mode: 'on',
      onBoard: true,
      labels: [],
      stage: 'Ready',
      blocked: 'stalled',
      mission: 'analyse',
      holds: { hold: { reason: 'stalled' }, releasedAt: null },
    },
    config,
  );
  assert.equal(action.row, 'mission.analyse.complete');
  assert.notEqual(action.type, 'release-hold');
});

test('decide: mission analyse at Ready does not launch; board mission reaches ready.launch', () => {
  const config = loadConfig();
  const facts = readyFactsBase();
  const analyseAction = decide({ ...facts, mission: 'analyse' }, config);
  assert.equal(analyseAction.type, 'none');
  assert.equal(analyseAction.row, 'mission.analyse.complete');

  const boardAction = decide({ ...facts, mission: 'board' }, config);
  assert.notEqual(boardAction.row, 'mission.analyse.complete');
  assert.equal(boardAction.type, 'launch');
  assert.equal(boardAction.row, 'ready.launch');
});
test('decide: an analyse-only issue at Ready stops on a board tick; removing the label lets delivery launch (PIPE-V2-D-ANALYSE-004)', () => {
  const config = loadConfig();
  const facts = readyFactsBase();
  const held = decide({ ...facts, labels: [...(facts.labels || []), 'analyse-only'] }, config);
  assert.equal(held.type, 'none');
  assert.equal(held.row, 'mission.analyse.complete');
  const released = decide({ ...facts, labels: (facts.labels || []).filter((label) => label !== 'analyse-only') }, config);
  assert.equal(released.row, 'ready.launch');
});
