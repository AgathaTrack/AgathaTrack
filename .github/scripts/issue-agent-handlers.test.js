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
    setIssueStage: async () => {
      calls.push('stage');
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

  assert.deepEqual(calls, ['labels', 'reopen', 'stage', 'comment']);
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

  assert.deepEqual(calls, ['reopen', 'stage', 'comment']);
  assert.equal(result.results[0].status, 'In UAT');
  assert.equal(result.results[0].issueNumber, 2258);
});

test('handleUatWorkflowResult writes the org Stage field to In UAT, not the board Status', async (t) => {
  stubQueue(t, 'syncDeployResult');
  const { io } = recordingIo(
    { title: 'light-plan: truthful-outcomes release debt (Plan B)', state: 'CLOSED' },
    'Refs #2258',
  );
  const stageWrites = [];
  io.setIssueStage = async (args) => {
    stageWrites.push(args);
  };

  await handleUatWorkflowResult({
    owner: 'AgathaTrack',
    repo: 'AgathaTrack',
    deployRef: 'uat-261118-2437',
    conclusion: 'success',
    workflowUrl: 'https://github.com/AgathaTrack/AgathaTrack/actions/runs/44305057834',
    token: 'test-token',
    projectsPat: 'projects-pat',
    projectId: 'project',
    statusFieldId: 'status-field',
    io,
  });

  assert.deepEqual(stageWrites, [
    {
      owner: 'AgathaTrack',
      repo: 'AgathaTrack',
      issueNumber: 2258,
      stageName: 'In UAT',
      projectsPat: 'projects-pat',
    },
  ]);
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
    setIssueStage: async () => calls.push('stage'),
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
  assert.deepEqual(calls, ['stage', 'labels', 'close', 'comment']);
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

function withV2Env(t, env) {
  const keys = ['ISSUE_PIPELINE_V2', 'ISSUE_PIPELINE_V2_LABEL'];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  });
}

const mergedArgs = {
  owner: 'KanopeeKa',
  repo: 'AgathaTrack',
  prNumber: 2417,
  prBody: 'Refs #2335',
  mergeSha: '866eff89a7ea402f2c60d365cc9c2d7cf49a163c',
  token: 'test-token',
  projectsPat: 'projects-pat',
  projectId: 'project',
  statusFieldId: 'status-field',
};

test('v2 engine owns the issue: the merge handler leaves it alone (no busy removal, reopen, status or comment)', async (t) => {
  stubQueue(t, 'syncEnqueueAfterMerge');
  withV2Env(t, { ISSUE_PIPELINE_V2: 'on' });
  const { calls, io } = recordingIo({ title: 'Remove orphaned helpers', state: 'OPEN' }, 'Refs #2335');
  const result = await handleMergedPr({ ...mergedArgs, io });
  assert.deepEqual(calls, []);
  assert.equal(result.results[0].status, 'skipped-v2-owned');
});

test('v2 dry-run or off: the merge handler works as before', async (t) => {
  stubQueue(t, 'syncEnqueueAfterMerge');
  for (const mode of ['dry-run', 'off']) {
    withV2Env(t, { ISSUE_PIPELINE_V2: mode });
    const { calls, io } = recordingIo({ title: 'Remove orphaned helpers', state: 'CLOSED' }, 'Refs #2335');
    const result = await handleMergedPr({ ...mergedArgs, io });
    assert.deepEqual(calls, ['labels', 'reopen', 'stage', 'comment'], mode);
    assert.equal(result.results[0].status, 'In Main');
  }
});

test('with a soak label only labelled issues are skipped by the merge handler', async (t) => {
  stubQueue(t, 'syncEnqueueAfterMerge');
  withV2Env(t, { ISSUE_PIPELINE_V2: 'on', ISSUE_PIPELINE_V2_LABEL: 'pipeline-beta' });
  const unlabelled = recordingIo({ title: 'Remove orphaned helpers', state: 'CLOSED', labels: { nodes: [{ name: 'task' }] } }, 'Refs #2335');
  const a = await handleMergedPr({ ...mergedArgs, io: unlabelled.io });
  assert.deepEqual(unlabelled.calls, ['labels', 'reopen', 'stage', 'comment']);
  assert.equal(a.results[0].status, 'In Main');
  const labelled = recordingIo({ title: 'Remove orphaned helpers', state: 'OPEN', labels: { nodes: [{ name: 'pipeline-beta' }] } }, 'Refs #2335');
  const b = await handleMergedPr({ ...mergedArgs, io: labelled.io });
  assert.deepEqual(labelled.calls, []);
  assert.equal(b.results[0].status, 'skipped-v2-owned');
});

test('v2 engine owns the issue: the UAT handler leaves it alone', async (t) => {
  stubQueue(t, 'syncDeployResult');
  withV2Env(t, { ISSUE_PIPELINE_V2: 'on' });
  const { calls, io } = recordingIo({ title: 'Remove orphaned helpers', state: 'OPEN' }, 'Refs #2335');
  const result = await handleUatWorkflowResult({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    deployRef: 'uat-261117-2417',
    conclusion: 'success',
    workflowUrl: 'https://github.com/AgathaTrack/AgathaTrack/actions/runs/1',
    token: 'test-token',
    projectsPat: 'projects-pat',
    projectId: 'project',
    statusFieldId: 'status-field',
    io,
  });
  assert.deepEqual(calls, []);
  assert.equal(result.results[0].status, 'skipped-v2-owned');
});

test('v2 engine owns the issue: the prod handler does not close it', async (t) => {
  withV2Env(t, { ISSUE_PIPELINE_V2: 'on' });
  const { calls, io } = recordingIo({ title: 'Remove orphaned helpers', state: 'OPEN' }, 'Refs #2335');
  io.listProjectIssues = async () => [{ status: 'In UAT', issue: { number: 2335 } }];
  io.fetchAllIssueComments = async () => [];
  io.closeIssue = async () => {
    calls.push('close');
  };
  const result = await handleProdDeployResult({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    commitSha: '866eff89a7ea402f2c60d365cc9c2d7cf49a163c',
    prodTag: 'v1.2.3',
    workflowUrl: 'https://github.com/AgathaTrack/AgathaTrack/actions/runs/2',
    token: 'test-token',
    projectsPat: 'projects-pat',
    projectId: 'project',
    statusFieldId: 'status-field',
    io,
  });
  assert.deepEqual(calls, []);
  assert.equal(result.results[0].status, 'skipped-v2-owned');
});

test('v2 engine owns the issue: the prod fallback without project config does not close it', async (t) => {
  withV2Env(t, { ISSUE_PIPELINE_V2: 'on' });
  const { calls, io } = recordingIo({ title: 'Remove orphaned helpers', state: 'OPEN' }, 'Fixes #2335');
  io.fetchPullsForCommit = async () => [{ body: 'Fixes #2335' }];
  io.closeIssue = async () => {
    calls.push('close');
  };
  const result = await handleProdDeployResult({
    owner: 'KanopeeKa',
    repo: 'AgathaTrack',
    commitSha: '866eff89a7ea402f2c60d365cc9c2d7cf49a163c',
    prodTag: 'v1.2.3',
    workflowUrl: 'https://github.com/AgathaTrack/AgathaTrack/actions/runs/2',
    token: 'test-token',
    projectsPat: null,
    projectId: null,
    statusFieldId: null,
    io,
  });
  assert.deepEqual(calls, []);
  assert.equal(result.results[0].status, 'skipped-v2-owned');
});
