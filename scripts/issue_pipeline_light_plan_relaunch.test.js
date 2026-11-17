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
  assert.equal(
    lightPlanResumeEligible({ issue: busyLightPlanIssue, prUrl: null, genuinelyBlocked: false }),
    true,
  );
  assert.equal(
    lightPlanResumeEligible({ issue: busyLightPlanIssue, prUrl: 'https://x', genuinelyBlocked: false }),
    false,
  );
  assert.equal(
    lightPlanResumeEligible({ issue: busyLightPlanIssue, prUrl: null, genuinelyBlocked: true }),
    false,
  );
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
      fetchIssue: async () => busyLightPlanIssue,
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
    if (String(url).includes('api.cursor.com')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(runPayload),
        json: async () => runPayload,
      };
    }
    if (String(url).includes('graphql')) {
      return graphqlIssueResponse();
    }
    if (onGithubPost && String(url).startsWith('https://api.github.com')) {
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
      found: {
        marker: { agentId: 'a', runId: 'b', status: 'running' },
      },
    });
    assert.equal(result.action, 'light-plan-resume');
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