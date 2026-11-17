'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { plan, run } = require('./issue_pipeline_v2_migrate');

test('Stage: empty takes the board column, Backlog when there is none, conflicts are only reported', () => {
  assert.deepEqual(plan({ stage: '', status: 'In progress', blocked: '' }).writes, { stage: 'In progress' });
  assert.deepEqual(plan({ stage: '', status: 'In Progress', blocked: '' }).writes, { stage: 'In progress' }, 'case-insensitive');
  assert.deepEqual(plan({ stage: '', status: '', blocked: '' }).writes, { stage: 'Backlog' });
  assert.deepEqual(plan({ stage: 'Ready', status: 'Ready', blocked: '' }), { writes: {}, notes: [] });
  const conflict = plan({ stage: 'Ready', status: 'Done', blocked: '' });
  assert.deepEqual(conflict.writes, {});
  assert.deepEqual(conflict.notes, ['stage-status-differ:Ready/Done']);
  assert.deepEqual(plan({ stage: '', status: 'Triage', blocked: '' }), { writes: {}, notes: ['unmapped-status:Triage'] });
  assert.deepEqual(plan({ stage: 'Nonsense', status: '', blocked: '' }).notes, ['unknown-stage:Nonsense']);
});

test('Blocked: legacy labels map when Blocked is empty; control issues keep needs-owner', () => {
  const base = { stage: 'To do', status: 'To do' };
  assert.deepEqual(plan({ ...base, blocked: '', labels: ['question'] }).writes, { blocked: 'question' });
  assert.deepEqual(plan({ ...base, blocked: '', labels: ['needs-owner'] }).writes, { blocked: 'decision' });
  assert.deepEqual(plan({ ...base, blocked: '', labels: ['needs-owner'], title: 'execute-plan: x' }).writes, {});
  assert.deepEqual(plan({ ...base, blocked: 'stalled', labels: ['needs-owner'] }).writes, {}, 'never overwrites a reason');
  assert.deepEqual(plan({ ...base, blocked: '', labels: ['question', 'needs-owner'] }).writes, { blocked: 'question' });
});

const fields = {
  stage: { id: 1, name: 'Stage', options: [] },
  blocked: { id: 2, name: 'Blocked', options: [] },
  attempts: { id: 3, name: 'Attempts', options: [] },
  totalN: { id: 4, name: 'Total N', options: [] },
};
const ref = (number, extra = {}) => ({ number, state: 'OPEN', repository: { name: 'r', owner: { login: 'o' } }, ...extra });

function boardIo(extra = {}) {
  const issues = {
    1: { number: 1, title: 'a', labels: [{ name: 'question' }], issue_field_values: [] },
    2: { number: 2, title: 'b', labels: [], issue_field_values: [{ field_id: 1, single_select_option: { name: 'Ready' } }] },
  };
  return {
    config: { engine: { logins: ['pawpet-engine'] }, agents: [] },
    fields,
    listProjectIssues: async () => [
      { issue: ref(1), status: 'To do' },
      { issue: ref(2), status: 'Ready' },
      { issue: ref(3, { state: 'CLOSED' }), status: 'Done' },
      { issue: ref(4, { repository: { name: 'other', owner: { login: 'o' } } }), status: 'To do' },
    ],
    getIssue: async (n) => issues[n],
    ...extra,
  };
}

test('run: dry-run reports and writes nothing; closed and other-repo issues are skipped', async () => {
  const written = [];
  const report = await run({
    owner: 'o', repo: 'r', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', apply: false,
    io: boardIo({ writeIssueFields: async (args) => written.push(args) }),
  });
  assert.deepEqual(report.map((e) => e.issue), [1, 2]);
  assert.deepEqual(report[0].writes, { stage: 'To do', blocked: 'question' });
  assert.deepEqual(report[1].writes, {});
  assert.deepEqual(written, []);
});

test('run: --apply needs the engine identity and then writes only the changed issues', async () => {
  await assert.rejects(
    run({ owner: 'o', repo: 'r', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', apply: true,
      io: boardIo({ checkEngineIdentity: async () => ({ ok: false, reason: 'token-not-engine-identity' }) }) }),
    /engine identity \(token-not-engine-identity\)/,
  );
  const written = [];
  const report = await run({
    owner: 'o', repo: 'r', projectsPat: 'p', projectId: 'P', statusFieldId: 'S', apply: true,
    io: boardIo({
      checkEngineIdentity: async () => ({ ok: true }),
      writeIssueFields: async (args) => written.push([args.issueNumber, args.writes, args.dryRun]),
    }),
  });
  assert.deepEqual(written, [[1, { stage: 'To do', blocked: 'question' }, false]]);
  assert.equal(report[0].applied, true);
});
