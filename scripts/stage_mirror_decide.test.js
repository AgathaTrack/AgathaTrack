'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decideStageMirror } = require('./stage_mirror_decide');

const PAWPET = [
  'Backlog',
  'To do',
  'In Analysis',
  'Ready',
  'In progress',
  'In Main',
  'In UAT',
  'Done',
];

const cases = [
  {
    name: 'in sync — refresh S only',
    P: 'Ready',
    F: 'Ready',
    S: 'To do',
    want: { action: 'sync_s', newS: 'Ready', reason: 'in_sync_refresh_s' },
  },
  {
    name: 'in sync — no writes',
    P: 'Ready',
    F: 'Ready',
    S: 'Ready',
    want: { action: 'none', reason: 'in_sync' },
  },
  {
    name: 'card moved',
    P: 'In progress',
    F: 'Ready',
    S: 'Ready',
    want: { action: 'field_from_board', newF: 'In progress', newS: 'In progress', reason: 'card_moved' },
  },
  {
    name: 'field changed',
    P: 'Ready',
    F: 'In Analysis',
    S: 'Ready',
    want: { action: 'board_from_field', newP: 'In Analysis', newS: 'In Analysis', reason: 'field_changed' },
  },
  {
    name: 'first run — board seeds field',
    P: 'Backlog',
    F: '',
    S: '',
    want: { action: 'field_from_board', newF: 'Backlog', newS: 'Backlog', reason: 'first_run_board_wins' },
  },
  {
    name: 'conflict — board wins',
    P: 'Done',
    F: 'Ready',
    S: 'In progress',
    want: { action: 'field_from_board', newF: 'Done', newS: 'Done', reason: 'conflict_board_wins' },
  },
  {
    name: 'invalid field for board — board wins',
    P: 'Ready',
    F: 'Triaged',
    S: 'Ready',
    want: { action: 'field_from_board', newF: 'Ready', newS: 'Ready', reason: 'invalid_field_board_wins' },
  },
  {
    name: 'case-insensitive in sync',
    P: 'In Analysis',
    F: 'In analysis',
    S: 'In Analysis',
    want: { action: 'none', reason: 'in_sync' },
  },
];

for (const row of cases) {
  test(row.name, () => {
    const plan = decideStageMirror(row.P, row.F, row.S, PAWPET);
    assert.deepEqual(
      {
        action: plan.action,
        ...(plan.newP ? { newP: plan.newP } : {}),
        ...(plan.newF ? { newF: plan.newF } : {}),
        ...(plan.newS ? { newS: plan.newS } : {}),
        reason: plan.reason,
      },
      row.want,
    );
  });
}