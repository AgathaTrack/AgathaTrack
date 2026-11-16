'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLinkedIssues,
  isPlanControlIssue,
  uatTagName,
  parseUatTag,
  handleMergedPr,
  handleUatWorkflowResult,
  handleProdDeployResult,
  parseTrustedMergeCommitFromComments,
  lightPlanHasOpenChecklistItems,
  isLightPlanTrackingIssue,
} = require('./issue-agent-handlers');

test('parseLinkedIssues accepts refs fixes closes resolves', () => {
  const body = 'Summary\n\nRefs #122\nAlso related to Fixes #99';
  assert.deepEqual(parseLinkedIssues(body), [122, 99]);
});

test('parseLinkedIssues deduplicates issue numbers', () => {
  const body = 'Refs #5 and refs #5';
  assert.deepEqual(parseLinkedIssues(body), [5]);
});

test('uatTagName uses YYMMDD and PR number', () => {
  const now = new Date('2026-07-16T15:00:00Z');
  assert.equal(uatTagName(193, now), 'uat-260716-193');
});

test('parseUatTag extracts PR number from tag', () => {
  assert.deepEqual(parseUatTag('uat-260716-193'), {
    yymmdd: '260716',
    prNumber: 193,
  });
});

test('parseUatTag rejects legacy release branch names', () => {
  assert.equal(parseUatTag('release/uat-260716-issue-122'), null);
});

test('handleMergedPr enqueues UAT queue when PR has no linked issues', async (t) => {
  const originalEnv = process.env.UAT_COORDINATION_ISSUE;
  process.env.UAT_COORDINATION_ISSUE = '313';

  const saved = [];
  const mod = require('../../scripts/lib/uat_queue_apply');
  const original = mod.syncEnqueueAfterMerge;
  mod.syncEnqueueAfterMerge = async (input) => {
    saved.push(input);
    return { skipped: false, entry: { seq: 26 }, issueNumber: 313 };
  };
  t.after(() => {
    mod.syncEnqueueAfterMerge = original;
    if (originalEnv === undefined) {
      delete process.env.UAT_COORDINATION_ISSUE;
    } else {
      process.env.UAT_COORDINATION_ISSUE = originalEnv;
    }
  });

  const result = await handleMergedPr({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    prNumber: 361,
    prBody: 'Wave B integration merge — no Closes line',
    mergeSha: '4a9036584b7f4dc0ccb446b93022c8f4903d2067',
    token: 'test-token',
    projectsPat: null,
    projectId: null,
    statusFieldId: null,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no linked issues');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].enqueuedBy, 'pr-361');
  assert.equal(saved[0].prNumber, 361);
});

test('isPlanControlIssue matches execute-plan titles only', () => {
  const executePlanTitles = [
    'execute-plan: All care by care item (all-care-by-item-c455)',
    'Execute-plan: documentation-migration-csm-514a',
    'execute-plan v2: drill-2 cancel path for API-launched workers',
    '[execute-plan] away-plan-care-review-ux',
  ];
  for (const title of executePlanTitles) {
    assert.equal(isPlanControlIssue({ title }), true, title);
  }
  const lightPlanTitles = [
    'light-plan: truthful-outcomes release debt (Plan B)',
    'Light-plan: Health Issues UI — care-desk alignment',
  ];
  for (const title of lightPlanTitles) {
    assert.equal(isPlanControlIssue({ title }), false, title);
  }
  assert.equal(
    isPlanControlIssue({
      title: 'Single agent-PR safety gate in execute-plan-scope (owner override)',
    }),
    false,
  );
  assert.equal(isPlanControlIssue({ title: 'Bell stays wrong after mark-all-read' }), false);
});

function recordingIo(issue, prBody) {
  const calls = [];
  const io = {
    fetchPullRequest: async () => ({ body: prBody }),
    fetchIssue: async () => issue,
    setLabels: async () => {
      calls.push('labels');
    },
    reopenIssue: async () => {
      calls.push('reopen');
    },
    updateProjectStatus: async () => {
      calls.push('status');
    },
    upsertMarkerComment: async () => {
      calls.push('comment');
    },
    assignIssue: async () => {
      calls.push('assign');
    },
  };
  return { calls, io };
}

function stubQueue(t, method) {
  const mod = require('../../scripts/lib/uat_queue_apply');
  const original = mod[method];
  mod[method] = async () => ({ skipped: true, reason: 'test' });
  t.after(() => {
    mod[method] = original;
  });
}

test('handleMergedPr sets In Main for light-plan tracking issues', async (t) => {
  stubQueue(t, 'syncEnqueueAfterMerge');
  const { calls, io } = recordingIo(
    { title: 'light-plan: truthful-outcomes release debt (Plan B)', state: 'CLOSED' },
    'Refs #2258',
  );

  const result = await handleMergedPr({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    prNumber: 2280,
    prBody: 'Release\n\nRefs #2258',
    mergeSha: '639cb48148a47a6edfcde28d880a3f582f772e46',
    token: 'test-token',
    projectsPat: 'projects-pat',
    projectId: 'project',
    statusFieldId: 'status-field',
    io,
  });

  assert.deepEqual(calls, ['labels', 'reopen', 'status', 'comment']);
  assert.equal(result.results[0].status, 'In Main');
  assert.equal(result.results[0].issueNumber, 2258);
});

test('handleMergedPr reopens execute-plan control without UAT status', async (t) => {
  stubQueue(t, 'syncEnqueueAfterMerge');
  const { calls, io } = recordingIo(
    { title: 'execute-plan: drill-2', state: 'CLOSED' },
    'Refs #2259',
  );

  const result = await handleMergedPr({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    prNumber: 2281,
    prBody: 'Release\n\nRefs #2259',
    mergeSha: '639cb48148a47a6edfcde28d880a3f582f772e46',
    token: 'test-token',
    projectsPat: 'projects-pat',
    projectId: 'project',
    statusFieldId: 'status-field',
    io,
  });

  assert.deepEqual(calls, ['labels', 'reopen']);
  assert.equal(result.results[0].status, 'reopened-plan-control');
  assert.equal(result.results[0].issueNumber, 2259);
});

test('handleUatWorkflowResult sets In UAT for light-plan tracking issues', async (t) => {
  stubQueue(t, 'syncDeployResult');
  const { calls, io } = recordingIo(
    { title: 'light-plan: truthful-outcomes release debt (Plan B)', state: 'CLOSED' },
    'Refs #2258',
  );

  const result = await handleUatWorkflowResult({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    deployRef: 'uat-261111-2280',
    conclusion: 'success',
    workflowUrl: 'https://github.com/AgathaTrack/AgathaTrack/actions/runs/43084042911',
    token: 'test-token',
    projectsPat: 'projects-pat',
    projectId: 'project',
    statusFieldId: 'status-field',
    io,
  });

  assert.deepEqual(calls, ['reopen', 'status', 'comment']);
  assert.equal(result.results[0].status, 'In UAT');
  assert.equal(result.results[0].issueNumber, 2258);
});

test('handleUatWorkflowResult still reopens a closed product issue', async (t) => {
  stubQueue(t, 'syncDeployResult');
  const { calls, io } = recordingIo(
    { title: 'Bell stays wrong after mark-all-read', state: 'CLOSED' },
    'Fixes #122',
  );

  const result = await handleUatWorkflowResult({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    deployRef: 'uat-261111-2280',
    conclusion: 'success',
    workflowUrl: 'https://github.com/AgathaTrack/AgathaTrack/actions/runs/1',
    token: 'test-token',
    projectsPat: null,
    projectId: null,
    statusFieldId: null,
    io,
  });

  assert.deepEqual(calls, ['reopen', 'comment']);
  assert.equal(result.results[0].status, 'In UAT');
  assert.equal(result.results[0].issueNumber, 122);
});

test('parseTrustedMergeCommitFromComments ignores non-bot authors', () => {
  const mergeSha = 'a'.repeat(40);
  const sha = parseTrustedMergeCommitFromComments([
    {
      user: { login: 'mallory' },
      body: `<!-- agent-uat-branch -->\nMerge commit: \`${mergeSha}\``,
      created_at: '2026-11-16T12:00:00Z',
    },
    {
      user: { login: 'pawpet-bot' },
      body: `<!-- agent-uat-branch -->\nMerge commit: \`${mergeSha}\``,
      updated_at: '2026-11-16T11:00:00Z',
      created_at: '2026-11-16T10:00:00Z',
    },
  ]);
  assert.equal(sha, mergeSha);
});

test('lightPlanHasOpenChecklistItems detects open programme items', () => {
  const body = '## Checklist\n\n- [x] P1 done\n- [ ] P2 open\n';
  assert.equal(lightPlanHasOpenChecklistItems(body), true);
  assert.equal(isLightPlanTrackingIssue({ title: 'light-plan: foo' }), true);
});

test('handleProdDeployResult closes In UAT issues when merge is in deploy', async () => {
  const mergeSha = 'b'.repeat(40);
  const deploySha = 'c'.repeat(40);
  const calls = [];
  const io = {
    listProjectIssues: async () => [
      { status: 'In UAT', issue: { number: 50 } },
      { status: 'Ready', issue: { number: 99 } },
    ],
    fetchAllIssueComments: async () => [
      {
        user: { login: 'pawpet-bot' },
        body: `<!-- agent-uat-branch -->\nMerge commit: \`${mergeSha}\``,
        updated_at: '2026-11-16T12:00:00Z',
      },
    ],
    fetchIssue: async () => ({
      number: 50,
      title: 'Bug fix',
      body: 'Done',
      labels: { nodes: [{ name: 'busy' }] },
    }),
    compareCommits: async () => ({ status: 'ahead' }),
    updateProjectStatus: async () => calls.push('status'),
    setLabels: async () => calls.push('labels'),
    closeIssue: async () => calls.push('close'),
    upsertMarkerComment: async () => calls.push('comment'),
  };

  const result = await handleProdDeployResult({
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    commitSha: deploySha,
    prodTag: 'v1.2.3',
    workflowUrl: 'https://example.com/runs/1',
    token: 'test',
    projectsPat: 'pat',
    projectId: 'pid',
    statusFieldId: 'sid',
    io,
  });

  assert.equal(result.results[0].status, 'closed');
  assert.deepEqual(calls, ['status', 'labels', 'close', 'comment']);
});

test('handleProdDeployResult skips light-plan with open checklist', async () => {
  const mergeSha = 'd'.repeat(40);
  const io = {
    listProjectIssues: async () => [{ status: 'In UAT', issue: { number: 2363 } }],
    fetchAllIssueComments: async () => [
      {
        user: { login: 'pawpet-claude' },
        body: `<!-- agent-uat-branch -->\nMerge commit: \`${mergeSha}\``,
        updated_at: '2026-11-16T12:00:00Z',
      },
    ],
    fetchIssue: async () => ({
      number: 2363,
      title: 'light-plan: repair',
      body: '#### Checklist\n\n- [ ] P5 open\n',
    }),
    compareCommits: async () => ({ status: 'identical' }),
    upsertMarkerComment: async () => {},
  };

  const result = await handleProdDeployResult({
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    commitSha: mergeSha,
    prodTag: 'v1',
    workflowUrl: 'url',
    token: 'test',
    projectsPat: 'pat',
    projectId: 'pid',
    statusFieldId: 'sid',
    io,
  });

  assert.equal(result.results[0].status, 'skipped-open-checklist');
});
