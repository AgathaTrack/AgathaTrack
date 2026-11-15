'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSnapshotFromPlan } = require('../lib/execute_plan_snapshot_v2');
const {
  evaluatePipelinePlanPaths,
  checkInitProvenance,
  checkProductConvergence,
} = require('../lib/execute_plan_pipeline_approve');

const PLAN_MD = `# Proof

## Goal
x

## Phases

### Phase 1 — First
\`\`\`json
{ "allowed_paths": ["docs/**"], "exit_checklist": ["ok"] }
\`\`\`
`;

const SNAP = buildSnapshotFromPlan({
  planId: 'proof-build-label-7f3a',
  planMarkdown: PLAN_MD,
  controlIssue: 9,
  now: '2026-10-16T09:00:30Z',
  sourceIssue: 42,
});

test('evaluatePipelinePlanPaths rejects forbidden paths without sensitive approval', () => {
  const tracked = ['docs/a.md', 'db/migrations/001_evil.sql'];
  const badSnapMd = `# P

## Goal
g

## Phases

### Phase 1 — One
\`\`\`json
{ "allowed_paths": ["db/migrations/**"], "exit_checklist": ["ok"] }
\`\`\`
`;
  const bad = buildSnapshotFromPlan({
    planId: 'x-y-z-ab',
    planMarkdown: badSnapMd,
    controlIssue: 1,
    now: '2026-10-16T09:00:30Z',
  });
  const res = evaluatePipelinePlanPaths(bad, tracked);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-paths');
});

test('evaluatePipelinePlanPaths passes clean globs', () => {
  const res = evaluatePipelinePlanPaths(SNAP, ['docs/agent-efficiency/foo.md']);
  assert.equal(res.ok, true);
});

test('checkInitProvenance requires bot on init tip', () => {
  assert.equal(checkInitProvenance({ author: { login: 'pawpet-bot' } }, 'pawpet-bot').ok, true);
  assert.equal(checkInitProvenance({ author: { login: 'KanopeeKa' } }, 'pawpet-bot').ok, false);
});

test('checkProductConvergence requires green verdicts and body_sha', () => {
  const body = 'Issue body';
  const comments = [{
    body: '<!-- agent-state: {"body_sha":"abc","verdicts":{"pawpet-claude":"green","pawpet-bot":"green"},"converged_at":"2026-11-15T00:00:00.000Z"} -->',
    created_at: '2026-11-15T01:00:00Z',
  }];
  const fail = checkProductConvergence({ productBody: body, comments });
  assert.equal(fail.ok, false);
  const { bodySha } = require('../issue_pipeline_state');
  const sha = bodySha(body);
  const good = [{
    body: `<!-- agent-state: ${JSON.stringify({
      body_sha: sha,
      verdicts: { 'pawpet-claude': 'green', 'pawpet-bot': 'green' },
      converged_at: '2026-11-15T00:00:00.000Z',
    })} -->`,
    created_at: '2026-11-15T01:00:00Z',
  }];
  const res = checkProductConvergence({ productBody: body, comments: good });
  assert.equal(res.ok, true);
});