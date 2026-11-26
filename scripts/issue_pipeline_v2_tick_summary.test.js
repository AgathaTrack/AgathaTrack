'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tick } = require('./issue_pipeline_v2');

const fields = {
  stage: { id: 1, name: 'Stage', options: ['Backlog', 'To do', 'Ready'] },
  blocked: { id: 2, name: 'Blocked', options: [] },
  attempts: { id: 3, name: 'Attempts', options: [] },
};

function issueBody(number, stage = 'Backlog', labels = []) {
  return {
    number,
    state: 'OPEN',
    labels: labels.map((name) => ({ name })),
    body: `Issue ${number}`,
    issue_field_values: [{ field_id: 1, single_select_option: { name: stage } }],
  };
}

test('partial issue read: other issues still get decisions (#2556 P2)', async () => {
  const prior = process.env.ISSUE_PIPELINE_V2;
  process.env.ISSUE_PIPELINE_V2 = 'dry-run';
  try {
    const result = await tick({
      owner: 'o',
      repo: 'r',
      token: 't',
      projectsPat: 'p',
      projectId: 'P',
      statusFieldId: 'S',
      io: {
        fields,
        config: require('./issue_pipeline_v2_config').loadConfig(),
        listProjectIssues: async () => [
          { issue: { number: 1, state: 'OPEN' }, status: 'To do' },
          { issue: { number: 2, state: 'OPEN' }, status: 'To do' },
        ],
        getIssue: async (number) => {
          if (number === 1) throw new Error('issue read failed');
          return issueBody(2, 'Backlog');
        },
        fetchIssueBlockedBy: async () => ({ open: [], error: null }),
        listIssueComments: async () => [],
        applyAction: async () => ({ applied: [], calls: [] }),
        checkEngineIdentity: async () => ({ ok: false, reason: 'test' }),
      },
    });
    assert.equal(result.boardReadPartial, true);
    assert.equal(result.readFailures.length, 1);
    assert.equal(result.summary.decisions, 1);
  } finally {
    if (prior === undefined) delete process.env.ISSUE_PIPELINE_V2;
    else process.env.ISSUE_PIPELINE_V2 = prior;
  }
});