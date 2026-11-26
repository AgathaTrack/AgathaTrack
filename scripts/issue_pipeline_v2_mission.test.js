'use strict';

// Scoped pipeline ticks (mission=analyse, PIPE-V2-D-ANALYSE-001/002/003/005): the engine moves Backlog to
// To do at intake, never starts delivery at Ready, and the wake helper refuses bad input before dispatch.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveMission, missionGuard } = require('./issue_pipeline_mission');
const { decide } = require('./issue_pipeline_v2_decide');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { parseArgs } = require('./issue_pipeline_wake');

const WAKE = path.join(__dirname, 'issue_pipeline_wake.js');

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

test('missionGuard: analyse stops at Ready without launch', () => {
  const blocked = missionGuard('Ready', 'analyse');
  assert.equal(blocked?.row, 'mission.analyse.complete');
  assert.equal(missionGuard('In progress', 'analyse')?.row, 'mission.analyse.post-ready');
  assert.equal(missionGuard('To do', 'analyse'), null);
});

test('missionGuard: analyse allows Backlog and In analysis; Done is post-ready', () => {
  assert.equal(missionGuard('Backlog', 'analyse'), null);
  assert.equal(missionGuard('In analysis', 'analyse'), null);
  assert.equal(missionGuard('Done', 'analyse')?.row, 'mission.analyse.post-ready');
});

test('missionGuard: board never blocks', () => {
  assert.equal(missionGuard('Ready', 'board'), null);
  assert.equal(missionGuard('Ready', undefined), null);
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

// --- Engine intake (PIPE-V2-D-ANALYSE-003, revised 2026-11-26): the engine, not the agent, moves Backlog to To do.

const analyseFacts = (over = {}) => ({
  mode: 'on',
  onBoard: true,
  labels: [],
  stage: 'Ready',
  blocked: null,
  bodyHash: 'abc',
  wip: { count: 0, limit: 2 },
  mission: 'analyse',
  ...over,
});

test('decide: mission analyse moves a Backlog issue to To do (engine intake, no agent Stage write)', () => {
  const action = decide(analyseFacts({ stage: 'Backlog' }), loadConfig());
  assert.equal(action.type, 'set-stage');
  assert.equal(action.to, 'To do');
  assert.equal(action.row, 'analyse.intake');
});

test('decide: board mission leaves a Backlog issue alone', () => {
  const action = decide(analyseFacts({ stage: 'Backlog', mission: 'board' }), loadConfig());
  assert.equal(action.type, 'none');
  assert.equal(action.reason, 'stage-backlog');
});

test('decide: mission analyse does not re-run intake on a To do issue', () => {
  const action = decide(analyseFacts({ stage: 'To do' }), loadConfig());
  assert.notEqual(action.row, 'analyse.intake');
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
