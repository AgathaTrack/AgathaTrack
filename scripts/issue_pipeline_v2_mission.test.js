'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMission, missionGuard } = require('./issue_pipeline_mission');
const { decide, canonicalStage } = require('./issue_pipeline_v2_decide');

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

test('decide: mission analyse skips ready.launch on Ready issue', () => {
  const config = { limits: { wip: 2 }, agents: [], engine: { logins: [] } };
  const facts = {
    mode: 'on',
    onBoard: true,
    labels: [],
    stage: 'Ready',
    blocked: null,
    bodyHash: 'abc',
    wip: { count: 0, limit: 2 },
    mission: 'analyse',
  };
  const action = decide(facts, config);
  assert.equal(action.type, 'none');
  assert.equal(action.row, 'mission.analyse.complete');
});