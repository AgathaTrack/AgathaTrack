'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyMirrorPlan, forEachRowIsolated, reconcileBoard } = require('./stage_mirror');

const BOARD = {
  projectId: 'PVT_board',
  statusFieldId: 'PVTSSF_status',
  syncedFieldId: 'PVTF_synced',
  columns: ['Backlog', 'Ready', 'In progress', 'Done'],
  owner: 'AgathaTrack',
  repo: 'AgathaTrack',
};
const STAGE_FIELD = { id: 49916872, options: ['Backlog', 'Ready', 'In progress', 'Done'] };
const ROW = { projectItemId: 'PVTI_item', issue: { number: 7, title: 'secret title', repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } } };

function fakeIo({ failOn = null } = {}) {
  const calls = [];
  const make = (name) => async () => {
    calls.push(name);
    if (failOn === name) {
      throw new Error(`${name} failed (simulated)`);
    }
    return {};
  };
  return {
    calls,
    io: {
      setIssueStageField: make('setIssueStageField'),
      fetchIssue: make('fetchIssue'),
      updateProjectStatus: make('updateProjectStatus'),
      updateProjectItemTextField: make('updateProjectItemTextField'),
    },
  };
}

const base = { board: BOARD, row: ROW, stageField: STAGE_FIELD, projectsPat: 'x', issueOwner: 'AgathaTrack', issueRepo: 'AgathaTrack', issueNum: 7 };

test('field_from_board: Stage is written before the synced value', async () => {
  const { calls, io } = fakeIo();
  await applyMirrorPlan({ ...base, plan: { action: 'field_from_board', newF: 'Ready', newS: 'Ready' } }, io);
  assert.deepEqual(calls, ['setIssueStageField', 'updateProjectItemTextField']);
});

test('field_from_board: failed Stage write leaves the synced value unchanged', async () => {
  const { calls, io } = fakeIo({ failOn: 'setIssueStageField' });
  await assert.rejects(
    applyMirrorPlan({ ...base, plan: { action: 'field_from_board', newF: 'Ready', newS: 'Ready' } }, io),
    /setIssueStageField failed/,
  );
  assert.deepEqual(calls, ['setIssueStageField'], 'S must not be written after a failed target write');
});

test('board_from_field: board is written before the synced value', async () => {
  const { calls, io } = fakeIo();
  await applyMirrorPlan({ ...base, plan: { action: 'board_from_field', newP: 'Done', newS: 'Done' } }, io);
  assert.deepEqual(calls, ['fetchIssue', 'updateProjectStatus', 'updateProjectItemTextField']);
});

test('board_from_field: failed board write leaves the synced value unchanged', async () => {
  const { calls, io } = fakeIo({ failOn: 'updateProjectStatus' });
  await assert.rejects(
    applyMirrorPlan({ ...base, plan: { action: 'board_from_field', newP: 'Done', newS: 'Done' } }, io),
    /updateProjectStatus failed/,
  );
  assert.deepEqual(calls, ['fetchIssue', 'updateProjectStatus']);
});

test('sync_s: only the synced value is written', async () => {
  const { calls, io } = fakeIo();
  await applyMirrorPlan({ ...base, plan: { action: 'sync_s', newS: 'Ready' } }, io);
  assert.deepEqual(calls, ['updateProjectItemTextField']);
});

function mirrorPorts(rows, stage) {
  return {
    assertSyncedField: async () => {},
    listIssues: async () => rows,
    readStage: async () => stage,
    fetchIssueForMirror: async () => ({ stage, typeName: null }),
  };
}

const WRITE_ROW = {
  ...ROW,
  status: 'Ready',
  syncedStage: '',
};

test('dry-run one row reports one planned write and zero applied', async () => {
  const { calls, io } = fakeIo();
  const stats = await reconcileBoard({
    board: { ...BOARD, key: 'support', label: 'Support' },
    stageField: STAGE_FIELD,
    projectsPat: 'x',
    dryRun: true,
    io,
    ports: mirrorPorts([WRITE_ROW], 'Backlog'),
  });
  assert.equal(stats.planned, 1);
  assert.equal(stats.applied, 0);
  assert.deepEqual(calls, []);
});

test('apply one row reports matching planned and applied writes', async () => {
  const { calls, io } = fakeIo();
  const stats = await reconcileBoard({
    board: { ...BOARD, key: 'support', label: 'Support' },
    stageField: STAGE_FIELD,
    projectsPat: 'x',
    dryRun: false,
    io,
    ports: mirrorPorts([WRITE_ROW], 'Backlog'),
  });
  assert.equal(stats.planned, 1);
  assert.equal(stats.applied, 1);
  assert.deepEqual(calls, ['setIssueStageField', 'updateProjectItemTextField']);
});

test('forEachRowIsolated: one failing row does not stop the others and is reported without its title', async () => {
  const rows = [
    { projectItemId: 'a', issue: { number: 1, repository: { name: 'AgathaTrackPrivate' } } },
    { projectItemId: 'b', issue: { number: 2, title: 'private title', repository: { name: 'AgathaTrackPrivate' } } },
    { projectItemId: 'c', issue: { number: 3, repository: { name: 'AgathaTrackPrivate' } } },
  ];
  const seen = [];
  const failures = await forEachRowIsolated(rows, async (row) => {
    seen.push(row.projectItemId);
    if (row.projectItemId === 'b') {
      throw new Error('PATCH failed (422)');
    }
  });
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.deepEqual(failures, [{ ref: 'AgathaTrackPrivate#2', message: 'PATCH failed (422)' }]);
  assert.equal(JSON.stringify(failures).includes('private title'), false);
});
