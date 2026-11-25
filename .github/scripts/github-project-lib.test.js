'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { projectRowsFromItems } = require('./github-project-lib');

const item = (id, state, status, extra = {}) => ({
  id,
  content: state ? { number: Number(id.replace('item-', '')), state } : null,
  fieldValues: { nodes: status ? [{ name: status, field: { id: 'S' } }] : [] },
  ...extra,
});

const items = [
  item('item-1', 'OPEN', 'In progress'),
  item('item-2', 'CLOSED', 'In Main'),
  item('item-3', 'CLOSED', 'Done'),
  item('item-4', null, 'Backlog'), // a draft item or a non-issue
  item('item-5', 'OPEN', null),
];

test('rows are open issues only by default, so every legacy caller keeps its behaviour', () => {
  const rows = projectRowsFromItems(items, { statusFieldId: 'S' });
  assert.deepEqual(rows.map((row) => row.issue.number), [1, 5]);
  assert.deepEqual(rows.map((row) => row.status), ['In progress', null]);
});

test('includeClosed also returns closed issues, with their board Status, and still drops non-issues', () => {
  const rows = projectRowsFromItems(items, { statusFieldId: 'S', includeClosed: true });
  assert.deepEqual(rows.map((row) => [row.issue.number, row.issue.state, row.status]), [
    [1, 'OPEN', 'In progress'],
    [2, 'CLOSED', 'In Main'],
    [3, 'CLOSED', 'Done'],
    [5, 'OPEN', null],
  ]);
});
