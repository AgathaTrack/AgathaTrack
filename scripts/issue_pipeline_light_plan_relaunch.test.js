'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lightPlanResumeEligible,
  lightPlanBusyActive,
  applyLightPlanRelaunch,
  applyStuckNeedsOwner,
} = require('./issue_pipeline_light_plan_relaunch');
const { buildLightPlanContinuePrompt } = require('./issue_pipeline_implement');
const { monitorIssue } = require('../.github/scripts/monitor-cursor-agent');

const busyLightPlanIssue = {
  labels: [{ name: 'light-plan' }, { name: 'busy' }],
};

test('lightPlanResumeEligible requires busy + light-plan and no genuine block', () => {
  assert.equal(lightPlanResumeEligible({ issue: busyLightPlanIssue, genuinelyBlocked: false }), true);
  assert.equal(lightPlanResumeEligible({ issue: busyLightPlanIssue, genuinelyBlocked: true }), false);
  assert.equal(lightPlanBusyActive({ labels: [{ name: 'PR' }, { name: 'busy' }] }), false);
});

test('buildLightPlanContinuePrompt leads with continue line', () => {
  const prompt = buildLightPlanContinuePrompt(
    { number: 42, title: 'light-plan: demo', url: 'u', body: 'x', labels: [] },
    'https://github.com/o/r',
  );
  assert.match(prompt, /^continue light-plan #42/);
  assert.match(prompt, /light-plan\/SKILL\.md/);
});

const pathsBlock = '```agent-paths\n{"globs":["scripts/**"]}\n```';

test('applyLightPlanRelaunch dry-run does not launch', async () => {
  let launched = false;
  const result = await applyLightPlanRelaunch({
    owner: 'o',
    repo: 'r',
    issueNumber: 9,
    token: 't',
    assignToken: 'bot',
    dryRun: true,
    io: {
      fetchIssue: async () => ({ ...busyLightPlanIssue, body: pathsBlock }),
      fetchAllIssueComments: async () => [],
      launchAgent: async () => {
        launched = true;
        return {};
      },
    },
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.relaunch, true);
  assert.equal(launched, false);
  assert.equal(result.stuck, 1);
});

test('applyStuckNeedsOwner dry-run reports stuck limit', async () => {
  const result = await applyStuckNeedsOwner({
    owner: 'o',
    repo: 'r',
    issueNumber: 9,
    token: 't',
    assignToken: 'bot',
    state: { stuck: 2 },
    stuck: 3,
    dryRun: true,
  });
  assert.equal(result.stuckLimit, true);
  assert.equal(result.stuck, 3);
  assert.equal(result.nextState.owner_reason, 'stuck');
});

function liveIo(overrides = {}) {
  const calls = { launched: 0, labels: [], assigned: [], markers: [] };
  const io = {
    fetchIssue: async () => ({ ...busyLightPlanIssue, number: 9, title: 'light-plan: demo', url: 'u', body: pathsBlock }),
    fetchAllIssueComments: async () => [],
    listTrackedFiles: () => ['scripts/a.js'],
    launchAgent: async () => {
      calls.launched += 1;
      return { agent: { id: 'a1', url: 'au' }, run: { id: 'r1' } };
    },
    setLabels: async (_o, _r, _n, add, remove) => calls.labels.push({ add, remove }),
    assignIssue: async (_o, _r, _n, login) => calls.assigned.push(login),
    upsertMarkerComment: async (args) => calls.markers.push(args.marker),
    ...overrides,
  };
  return { io, calls };
}

const liveArgs = { owner: 'o', repo: 'r', issueNumber: 9, token: 't', assignToken: 'bot', dryRun: false };

test('live relaunch launches, counts stuck and keeps busy', async () => {
  const { io, calls } = liveIo();
  const result = await applyLightPlanRelaunch({ ...liveArgs, io });
  assert.equal(result.relaunched, true);
  assert.equal(result.stuck, 1);
  assert.equal(calls.launched, 1);
  assert.deepEqual(calls.assigned, ['pawpet-bot']);
  assert.ok(calls.labels.some((l) => l.add.includes('busy')));
});

test('live relaunch at the stuck limit hands to the owner without launching', async () => {
  const prev = process.env.PIPELINE_STUCK_MAX;
  process.env.PIPELINE_STUCK_MAX = '1';
  try {
    const { io, calls } = liveIo();
    const result = await applyLightPlanRelaunch({ ...liveArgs, io });
    assert.equal(result.ownerReason, 'stuck');
    assert.equal(calls.launched, 0);
    assert.ok(calls.labels.some((l) => l.add.includes('needs-owner') && l.remove.includes('busy')));
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_STUCK_MAX;
    else process.env.PIPELINE_STUCK_MAX = prev;
  }
});

test('live relaunch fails closed when the launch throws', async () => {
  const { io, calls } = liveIo({
    launchAgent: async () => {
      throw new Error('boom');
    },
  });
  const result = await applyLightPlanRelaunch({ ...liveArgs, io });
  assert.equal(result.reason, 'launch-failed');
  assert.ok(calls.labels.some((l) => l.add.includes('needs-owner')));
});

test('live relaunch stops at the path gate', async () => {
  const { io, calls } = liveIo({ fetchIssue: async () => ({ ...busyLightPlanIssue, body: '' }) });
  const result = await applyLightPlanRelaunch({ ...liveArgs, io });
  assert.equal(result.reason, 'path-gate');
  assert.equal(calls.launched, 0);
});

test('a failing run-marker write after launch fails closed to the owner', async () => {
  const { io, calls } = liveIo({
    upsertMarkerComment: async () => {
      throw new Error('write failed');
    },
  });
  const result = await applyLightPlanRelaunch({ ...liveArgs, io });
  assert.equal(result.relaunched, true);
  assert.equal(result.handoffIncomplete, true);
  assert.equal(result.failedClosed, true);
  assert.ok(calls.labels.some((l) => l.add.includes('needs-owner') && l.remove.includes('busy')));
  assert.deepEqual(calls.assigned, ['KanopeeKa']);
});

test('detectBlockedResult treats an owner-decision stop as blocked', () => {
  const { detectBlockedResult } = require('../.github/scripts/monitor-cursor-agent');
  assert.equal(detectBlockedResult({ result: { text: 'Need owner decision: CI budget spent' } }), true);
  assert.equal(detectBlockedResult({ result: { text: 'session cut off' } }), false);
});

function graphqlIssueResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        repository: {
          issue: {
            id: 'I_1',
            number: 5,
            title: 'light-plan: demo',
            url: 'https://github.com/o/r/issues/5',
            body: '',
            labels: { nodes: [{ name: 'light-plan' }, { name: 'busy' }] },
          },
        },
      },
    }),
    text: async () => '{}',
  };
}

function mockFetchForMonitor({ runPayload, onGithubPost }) {
  return async (url, init) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch {
      parsed = null;
    }
    if (parsed && parsed.hostname === 'api.cursor.com') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(runPayload),
        json: async () => runPayload,
      };
    }
    if (parsed && parsed.hostname === 'api.github.com' && parsed.pathname === '/graphql') {
      return graphqlIssueResponse();
    }
    if (onGithubPost && parsed && parsed.hostname === 'api.github.com') {
      onGithubPost(url, init);
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };
}

test('monitorIssue returns light-plan-resume for terminal FINISHED without PR', async () => {
  const origFetch = global.fetch;
  global.fetch = mockFetchForMonitor({
    runPayload: { status: 'FINISHED', result: { text: 'done' } },
  });
  try {
    const result = await monitorIssue({
      owner: 'o',
      repo: 'r',
      issueNumber: 5,
      token: 't',
      apiKey: 'k',
      allowLightPlanResume: true,
      found: {
        marker: { agentId: 'a', runId: 'b', status: 'running' },
      },
    });
    assert.equal(result.action, 'light-plan-resume');
  } finally {
    global.fetch = origFetch;
  }
});

test('monitorIssue resumes light-plan with phase PR when pipeline caller', async () => {
  const origFetch = global.fetch;
  global.fetch = mockFetchForMonitor({
    runPayload: {
      status: 'FINISHED',
      result: { text: 'paused' },
      git: { branches: [{ prUrl: 'https://github.com/o/r/pull/9' }] },
    },
  });
  try {
    const result = await monitorIssue({
      owner: 'o',
      repo: 'r',
      issueNumber: 5,
      token: 't',
      apiKey: 'k',
      allowLightPlanResume: true,
      found: { marker: { agentId: 'a', runId: 'b', status: 'running' } },
    });
    assert.equal(result.action, 'light-plan-resume');
  } finally {
    global.fetch = origFetch;
  }
});

test('legacy monitor treats light-plan terminal run with PR as completed', async () => {
  const origFetch = global.fetch;
  global.fetch = mockFetchForMonitor({
    runPayload: {
      status: 'FINISHED',
      git: { branches: [{ prUrl: 'https://github.com/o/r/pull/9' }] },
    },
  });
  try {
    const result = await monitorIssue({
      owner: 'o',
      repo: 'r',
      issueNumber: 5,
      token: 't',
      apiKey: 'k',
      found: { marker: { agentId: 'a', runId: 'b', status: 'running' } },
    });
    assert.equal(result.action, 'completed');
  } finally {
    global.fetch = origFetch;
  }
});

test('monitorIssue still blocks light-plan when agent text is genuinely blocked', async () => {
  const origFetch = global.fetch;
  let labeledBlocked = false;
  global.fetch = mockFetchForMonitor({
    runPayload: {
      status: 'FINISHED',
      result: { text: 'cannot proceed without more information' },
    },
    onGithubPost: (_url, init) => {
      if (init?.body && String(init.body).includes('blocked')) {
        labeledBlocked = true;
      }
    },
  });
  try {
    const result = await monitorIssue({
      owner: 'o',
      repo: 'r',
      issueNumber: 5,
      token: 't',
      apiKey: 'k',
      allowLightPlanResume: true,
      found: {
        marker: { agentId: 'a', runId: 'b', status: 'running' },
      },
    });
    assert.equal(result.action, 'blocked');
    assert.equal(labeledBlocked, true);
  } finally {
    global.fetch = origFetch;
  }
});