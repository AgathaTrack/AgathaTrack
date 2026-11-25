'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  projectRowsFromItems,
  formatStatusOptionNotFoundError,
  suggestStatusOptionNames,
  listProjectIssues,
  filterRowsByRepository,
  projectRowMatchesRepo,
  PROJECT_ITEMS_PAGE_SIZE,
} = require('./github-project-lib');

const item = (id, state, status, extra = {}) => ({
  id,
  content: state
    ? {
        number: Number(id.replace('item-', '')),
        state,
        repository: extra.repository,
        ...extra.contentExtra,
      }
    : null,
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

test('suggestStatusOptionNames picks close pipeline column spellings', () => {
  const columns = ['In progress', 'In Main', 'In UAT', 'Done'];
  assert.deepEqual(suggestStatusOptionNames('In Mainn', columns), ['In Main']);
  assert.deepEqual(suggestStatusOptionNames('In Uatt', columns), ['In UAT']);
});

test('formatStatusOptionNotFoundError names the field, options, and workflow doc', () => {
  const message = formatStatusOptionNotFoundError('In Mainn', 'FIELD', ['In Main', 'In UAT']);
  assert.match(message, /Status option "In Mainn" not found/);
  assert.match(message, /Closest: In Main/);
  assert.match(message, /github-issue-workflow\.md/);
  assert.match(message, /Project \*\*Status\*\*/);
});

test('formatStatusOptionNotFoundError is board-neutral for ATSupport Status lookups', () => {
  const message = formatStatusOptionNotFoundError('Triagee', 'ATSUPPORT_STATUS_FIELD', [
    'Triaged',
    'In progress',
  ]);
  assert.match(message, /github-issue-workflow\.md/);
  assert.doesNotMatch(message, /PAWPET_COLUMNS/);
});

test('projectRowMatchesRepo matches owner login and repository name', () => {
  const row = {
    issue: { repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } } },
  };
  assert.equal(projectRowMatchesRepo(row, 'AgathaTrack', 'AgathaTrack'), true);
  assert.equal(projectRowMatchesRepo(row, 'Other', 'AgathaTrack'), false);
  assert.equal(projectRowMatchesRepo({ issue: {} }, 'AgathaTrack', 'AgathaTrack'), false);
});

test('filterRowsByRepository requires both owner and repo', () => {
  const rows = [
    { issue: { number: 1, repository: { name: 'A', owner: { login: 'O' } } } },
    { issue: { number: 2, repository: { name: 'B', owner: { login: 'O' } } } },
  ];
  assert.throws(() => filterRowsByRepository(rows, 'O', null), /owner and repo must both be set/);
  assert.deepEqual(filterRowsByRepository(rows, 'O', 'A').map((r) => r.issue.number), [1]);
  assert.deepEqual(filterRowsByRepository(rows, null, null).length, 2);
});

test('listProjectIssues paginates GraphQL pages and applies repo filter', async () => {
  const pageCalls = [];
  const graphqlFn = async (_pat, _query, variables) => {
    pageCalls.push(variables.after ?? null);
    if (variables.after == null) {
      return {
        node: {
          items: {
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
            nodes: [
              {
                id: 'pi-1',
                fieldValues: { nodes: [] },
                content: {
                  number: 1,
                  state: 'OPEN',
                  repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } },
                },
              },
              {
                id: 'pi-2',
                fieldValues: { nodes: [] },
                content: {
                  number: 2,
                  state: 'OPEN',
                  repository: { name: 'Private', owner: { login: 'AgathaTrack' } },
                },
              },
            ],
          },
        },
      };
    }
    return {
      node: {
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: 'pi-3',
              fieldValues: { nodes: [] },
              content: {
                number: 3,
                state: 'OPEN',
                repository: { name: 'AgathaTrack', owner: { login: 'AgathaTrack' } },
              },
            },
          ],
        },
      },
    };
  };

  const all = await listProjectIssues({
    projectId: 'P1',
    statusFieldId: 'S',
    projectsPat: 'token',
    graphqlFn,
  });
  assert.equal(all.length, 3);
  assert.deepEqual(pageCalls, [null, 'cursor-2']);

  pageCalls.length = 0;
  const filtered = await listProjectIssues({
    projectId: 'P1',
    statusFieldId: 'S',
    projectsPat: 'token',
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    graphqlFn,
  });
  assert.deepEqual(filtered.map((row) => row.issue.number), [1, 3]);
});

test('listProjectIssues requests page size 100 on each GraphQL page', async () => {
  let queryText = '';
  const graphqlFn = async (_pat, query) => {
    queryText = query;
    return { node: { items: { pageInfo: { hasNextPage: false }, nodes: [] } } };
  };
  await listProjectIssues({
    projectId: 'P1',
    statusFieldId: 'S',
    projectsPat: 'token',
    graphqlFn,
  });
  assert.match(queryText, new RegExp(`items\\(first: ${PROJECT_ITEMS_PAGE_SIZE}`));
});