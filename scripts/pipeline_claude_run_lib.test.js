'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStageTask, acceptanceEvidence } = require('./pipeline_claude_run_lib');
const { METHOD_PROMPTS, STAGE_PROMPTS } = require('./issue_pipeline_v2_launch');
const { verify } = require('./pipeline_claude_verify');
const { loadConfig } = require('./issue_pipeline_v2_config');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const SINCE = Date.parse('2026-11-24T12:00:00Z');
const prompts = { acceptance: 'Verify merge {{mergeSha}} for #{{number}}.' };

test('an acceptance task names the merge it judges', () => {
  const task = buildStageTask({ stage: 'acceptance', method: 'PR', prompts, number: 7, mergeSha: SHA });
  assert.equal(task, `Verify merge ${SHA} for #7.`);
  assert.doesNotMatch(task, /\{\{/);
});

test('an acceptance task without a full merge sha is refused', () => {
  for (const mergeSha of ['', undefined, 'abc123', SHA.toUpperCase(), `${SHA}0`]) {
    assert.throws(
      () => buildStageTask({ stage: 'acceptance', method: 'PR', prompts, number: 7, mergeSha }),
      /no valid merge_sha/,
      `rejects ${JSON.stringify(mergeSha)}`,
    );
  }
});

test('delivery keeps the method prompt and needs no merge sha', () => {
  assert.equal(buildStageTask({ stage: undefined, method: 'PR', prompts: STAGE_PROMPTS, number: 7 }), METHOD_PROMPTS.PR);
});

test('a real stage prompt is filled, never sent with a placeholder', () => {
  const task = buildStageTask({ stage: 'acceptance', method: 'PR', prompts: STAGE_PROMPTS, number: 7, mergeSha: SHA });
  assert.match(task, new RegExp(SHA));
  assert.doesNotMatch(task, /\{\{mergeSha\}\}/);
});

const verdict = (login, body, created = '2026-11-24T12:10:00Z', id = 5) => ({
  id, user: { login }, body, created_at: created,
});

test('acceptance evidence is the run login verdict on this merge, after the run started', () => {
  const comments = [verdict('pawpet-claude', `Checked.\n\n<!-- v2:aat verdict=pass merge=${SHA} -->\n`)];
  const out = acceptanceEvidence({ comments, actsAs: 'pawpet-claude', mergeSha: SHA, sinceMs: SINCE });
  assert.equal(out.ok, true);
  assert.equal(out.evidence, 'verdict 5');
});

test('a verdict on another merge, another login, an earlier time or the launch record is not evidence', () => {
  const body = (sha) => `<!-- v2:aat verdict=fail reason=scope merge=${sha} -->`;
  const cases = [
    [verdict('pawpet-claude', body(OTHER))],
    [verdict('pawpet-bot', body(SHA))],
    [verdict('pawpet-claude', body(SHA), '2026-11-24T11:00:00Z')],
    [verdict('pawpet-claude', `<!-- v2:aat-launch merge=${SHA} run=9 -->`)],
    [],
  ];
  for (const comments of cases) {
    assert.equal(acceptanceEvidence({ comments, actsAs: 'pawpet-claude', mergeSha: SHA, sinceMs: SINCE }).ok, false);
  }
});

test('verify passes an acceptance run that posted its verdict on the merge', async () => {
  const comments = [verdict('pawpet-claude', `<!-- v2:aat verdict=inconclusive merge=${SHA} -->`)];
  const result = await verify({
    owner: 'o', repo: 'r', issueNumber: 7, stage: 'acceptance', agentId: 'claude-a', mergeSha: SHA, sinceMs: SINCE,
    token: 't', deps: { config: loadConfig(), listIssueComments: async () => comments },
  });
  assert.equal(result.ok, true);
});

test('verify fails an acceptance run that left only a reply on the issue', async () => {
  const comments = [verdict('pawpet-claude', 'I looked at it but did not record a verdict.')];
  const result = await verify({
    owner: 'o', repo: 'r', issueNumber: 7, stage: 'acceptance', agentId: 'claude-a', mergeSha: SHA, sinceMs: SINCE,
    token: 't', deps: { config: loadConfig(), listIssueComments: async () => comments },
  });
  assert.equal(result.ok, false);
});
