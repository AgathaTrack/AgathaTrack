'use strict';

// Scoped pipeline ticks (mission=analyse, PIPE-V2-D-ANALYSE-001/002/003/005): the engine moves Backlog to
// To do at intake, never starts delivery at Ready, and the wake helper refuses bad input before dispatch.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { resolveMission, missionGuard } = require('./issue_pipeline_mission');
const { decide } = require('./issue_pipeline_v2_decide');
const { parseArgs } = require('./issue_pipeline_wake');

const config = loadConfig();
const WAKE = path.join(__dirname, 'issue_pipeline_wake.js');

function facts(over = {}) {
  return {
    mode: 'on',
    onBoard: true,
    labels: [],
    stage: 'Ready',
    blocked: null,
    bodyHash: 'abc',
    wip: { count: 0, limit: 2 },
    mission: 'analyse',
    ...over,
  };
}

test('resolveMission: board allows whole-board tick', () => {
  assert.deepEqual(resolveMission({ mission: 'board', issueNumber: null }), { ok: true, mission: 'board' });
  assert.deepEqual(resolveMission({ issueNumber: null }), { ok: true, mission: 'board' });
});

test('resolveMission: analyse requires issue_number', () => {
  assert.equal(resolveMission({ mission: 'analyse', issueNumber: null }).ok, false);
  assert.equal(resolveMission({ mission: 'analyse', issueNumber: 0 }).ok, false);
  assert.deepEqual(resolveMission({ mission: 'analyse', issueNumber: 42 }), { ok: true, mission: 'analyse' });
});

test('resolveMission: input is trimmed and case-folded; unknown missions refused', () => {
  assert.deepEqual(resolveMission({ mission: '  ANALYSE ', issueNumber: 7 }), { ok: true, mission: 'analyse' });
  assert.deepEqual(resolveMission({ mission: '', issueNumber: null }), { ok: true, mission: 'board' });
  assert.equal(resolveMission({ mission: 'deliver', issueNumber: 1 }).ok, false);
});

test('missionGuard: analyse allows Backlog, To do and In analysis; stops at Ready and after', () => {
  assert.equal(missionGuard('Backlog', 'analyse'), null);
  assert.equal(missionGuard('To do', 'analyse'), null);
  assert.equal(missionGuard('In analysis', 'analyse'), null);
  assert.equal(missionGuard('Ready', 'analyse')?.row, 'mission.analyse.complete');
  assert.equal(missionGuard('In progress', 'analyse')?.row, 'mission.analyse.post-ready');
  assert.equal(missionGuard('Done', 'analyse')?.row, 'mission.analyse.post-ready');
});

test('missionGuard: board never blocks', () => {
  assert.equal(missionGuard('Ready', 'board'), null);
  assert.equal(missionGuard('Ready', undefined), null);
});

test('decide: mission analyse skips ready.launch on Ready issue', () => {
  const action = decide(facts({ stage: 'Ready' }), config);
  assert.equal(action.type, 'none');
  assert.equal(action.row, 'mission.analyse.complete');
});

test('decide: mission analyse moves a Backlog issue to To do (engine intake, no agent Stage write)', () => {
  const action = decide(facts({ stage: 'Backlog' }), config);
  assert.equal(action.type, 'set-stage');
  assert.equal(action.to, 'To do');
  assert.equal(action.row, 'analyse.intake');
});

test('decide: board mission leaves a Backlog issue alone', () => {
  const action = decide(facts({ stage: 'Backlog', mission: 'board' }), config);
  assert.equal(action.type, 'none');
  assert.equal(action.reason, 'stage-backlog');
});

test('decide: mission analyse does not re-run intake on a To do issue', () => {
  const action = decide(facts({ stage: 'To do' }), config);
  assert.notEqual(action.row, 'analyse.intake');
});

test('decide: mission analyse refuses delivery rows after Ready', () => {
  const action = decide(facts({ stage: 'In progress' }), config);
  assert.equal(action.type, 'none');
  assert.equal(action.row, 'mission.analyse.post-ready');
});

test('parseArgs: defaults to mission analyse, not live', () => {
  assert.deepEqual(parseArgs(['node', 'wake', '--issue', '5']), {
    issue: '5', mission: 'analyse', live: false, help: false, error: null,
  });
});

test('parseArgs: --live and --mission are read', () => {
  const out = parseArgs(['node', 'wake', '--issue', '5', '--mission', 'board', '--live']);
  assert.equal(out.mission, 'board');
  assert.equal(out.live, true);
  assert.equal(out.error, null);
});

test('parseArgs: unknown flag or a flag without its value is an error, not silently ignored', () => {
  assert.match(parseArgs(['node', 'wake', '--issue', '5', '--lvie']).error, /unknown or incomplete/);
  assert.match(parseArgs(['node', 'wake', '--issue']).error, /unknown or incomplete/);
  assert.match(parseArgs(['node', 'wake', '--issue', '5', '--mission']).error, /unknown or incomplete/);
});

test('wake CLI refuses bad input before any dispatch (no gh call needed)', () => {
  const run = (...args) => spawnSync(process.execPath, [WAKE, ...args], { encoding: 'utf8' });

  const notAnInteger = run('--issue', 'abc');
  assert.equal(notAnInteger.status, 1);
  assert.match(notAnInteger.stderr, /positive integer/);

  const analyseWithoutIssue = run('--mission', 'analyse');
  assert.equal(analyseWithoutIssue.status, 1);
  assert.match(analyseWithoutIssue.stderr, /requires a positive issue_number/);

  const unknownMission = run('--issue', '5', '--mission', 'deliver');
  assert.equal(unknownMission.status, 1);
  assert.match(unknownMission.stderr, /mission must be one of/);

  const typoFlag = run('--issue', '5', '--lvie');
  assert.equal(typoFlag.status, 1);
  assert.match(typoFlag.stderr, /unknown or incomplete argument/);
});
