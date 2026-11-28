'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathsEligible, autoSkipEligible } = require('./aat_autoskip_eligibility');

const GLOBS = ['docs/**', 'scripts/pipeline_runners/**', '.cursor/skills/**'];

test('pathsEligible: each include glob and forbidden paths fail closed', () => {
  assert.equal(pathsEligible(['docs/foo.md'], GLOBS).eligible, true);
  assert.equal(pathsEligible(['scripts/pipeline_runners/x.js'], GLOBS).eligible, true);
  assert.equal(pathsEligible(['.cursor/skills/foo/SKILL.md'], GLOBS).eligible, true);
  assert.equal(pathsEligible(['server/routes/x.js'], GLOBS).eligible, false);
  assert.equal(pathsEligible(['flutter_app/lib/a.dart'], GLOBS).eligible, false);
  assert.equal(pathsEligible(['.github/workflows/x.yml'], GLOBS).eligible, false);
  assert.equal(pathsEligible(['auth/session.js'], GLOBS).eligible, false);
  assert.equal(pathsEligible(['billing/plan.js'], GLOBS).eligible, false);
  assert.equal(pathsEligible([], GLOBS).eligible, false);
  assert.equal(pathsEligible(['docs/a.md', 'server/b.js'], GLOBS).eligible, false);
});

test('pathsEligible: empty list and API-style errors via autoSkipEligible', () => {
  const cfg = { aat: { autoSkip: { enabled: true, globs: GLOBS } } };
  assert.equal(autoSkipEligible({ delivery: { changedPaths: ['docs/x.md'] } }, cfg).eligible, true);
  assert.equal(autoSkipEligible({ delivery: { changedPathsError: 'overflow' } }, cfg).eligible, false);
  assert.equal(autoSkipEligible({ delivery: { changedPaths: [] } }, cfg).eligible, false);
});