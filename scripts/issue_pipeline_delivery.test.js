'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAgentPathsBlock,
  expandGlobs,
  evaluateDeliveryPaths,
  decideDeliveryPlan,
  inferDeliveryMethod,
} = require('./issue_pipeline_delivery');

const TRACKED = [
  'flutter_app/lib/main.dart',
  'server/routes/pets.js',
  '.github/workflows/ci.yml',
  '.cursor/agent-kernel/ROUTER.md',
  'server/config/security.js',
];

test('parseAgentPathsBlock reads fenced JSON globs', () => {
  const body = 'Goal\n\n```agent-paths\n{"globs":["flutter_app/**"]}\n```\n';
  const parsed = parseAgentPathsBlock(body);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.globs, ['flutter_app/**']);
});

test('parseAgentPathsBlock fails when block missing', () => {
  const parsed = parseAgentPathsBlock('no paths here');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'missing-agent-paths');
});

test('evaluateDeliveryPaths rejects .github and agent-kernel matches', () => {
  const check = evaluateDeliveryPaths(['**/*'], TRACKED);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'sensitive-paths');
  assert.ok(check.protectedHits.some((p) => p.includes('.github/')));
});

test('evaluateDeliveryPaths rejects forbidden security config', () => {
  const check = evaluateDeliveryPaths(['server/config/security.js'], TRACKED);
  assert.equal(check.ok, false);
  assert.ok(check.forbiddenHits.includes('server/config/security.js'));
});

test('evaluateDeliveryPaths passes safe scoped globs', () => {
  const check = evaluateDeliveryPaths(['flutter_app/**'], TRACKED);
  assert.equal(check.ok, true);
  assert.deepEqual(check.expanded, ['flutter_app/lib/main.dart']);
});

test('decideDeliveryPlan queues when paths pass', () => {
  const plan = decideDeliveryPlan({
    method: 'PR',
    pathCheck: { ok: true },
    bodyEditedThisStep: false,
    liveBodySha: 'abc',
    stateBodySha: 'abc',
  });
  assert.equal(plan.kind, 'queued');
  assert.equal(plan.label, 'PR');
});

test('decideDeliveryPlan reopens when body changed this step', () => {
  const plan = decideDeliveryPlan({
    method: 'PR',
    pathCheck: { ok: true },
    bodyEditedThisStep: true,
    liveBodySha: 'new',
    stateBodySha: 'old',
  });
  assert.equal(plan.kind, 'reopen');
});

test('inferDeliveryMethod reads light-plan title prefix', () => {
  assert.equal(inferDeliveryMethod({ title: 'light-plan: issue pipeline' }), 'light-plan');
});

test('expandGlobs returns unique paths', () => {
  const expanded = expandGlobs(['server/routes/*.js'], TRACKED);
  assert.deepEqual(expanded, ['server/routes/pets.js']);
});