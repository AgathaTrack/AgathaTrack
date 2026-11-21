'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSections,
  evaluateIssue,
  buildComment,
  isMeaningfulText,
  detectRiskyScope,
} = require('./triage-lib');

test('parseSections extracts GitHub form headings', () => {
  const body = `### Current Behavior\n\nApp crashes on save.\n\n### Expected Behavior\n\nSave succeeds.`;
  const sections = parseSections(body);
  assert.equal(sections['current behavior'], 'App crashes on save.');
  assert.equal(sections['expected behavior'], 'Save succeeds.');
});

test('bug issue passes with complete form content', () => {
  const body = `### Current Behavior\n\nThe dashboard fails to load organization data after login.\n\n### Expected Behavior\n\nThe dashboard should show the selected organization summary.\n\n### Steps To Reproduce\n\n1. Sign in\n2. Open dashboard\n3. Observe empty state\n\n### Environment\n\n- OS: macOS\n- Browser: Chrome\n- Environment: local\n\n### Security or Sensitive Area\n\nNo`;
  const result = evaluateIssue({
    title: '[BUG] Dashboard empty after login',
    body,
    labels: ['bug'],
  });
  assert.equal(result.decision, 'pass');
});

test('bug issue fails when reproduction details are missing', () => {
  const result = evaluateIssue({
    title: '[BUG] Broken dashboard',
    body: '### Current Behavior\n\nBroken\n\n### Expected Behavior\n\nFixed',
    labels: ['bug'],
  });
  assert.equal(result.decision, 'question');
  assert.ok(result.missing.includes('steps to reproduce'));
});

test('feature issue requires acceptance criteria', () => {
  const body = `### Summary\n\nAdd CSV export for reports.\n\n### Problem to Solve\n\nUsers cannot export report data for offline analysis.\n\n### Proposed Solution\n\nAdd an export button on the reports page.\n\n### Acceptance Criteria\n\n- [ ] User can download CSV\n- [ ] Export respects filters\n\n### Security or Sensitive Area\n\nNo`;
  const result = evaluateIssue({
    title: '[FEATURE] CSV export',
    body,
    labels: ['feature'],
  });
  assert.equal(result.decision, 'pass');
});

test('task with auth scope is manual-only', () => {
  const body = `### Summary\n\nUpdate authentication middleware.\n\n### Objective\n\nHarden session validation for admin routes.\n\n### Scope\n\nserver auth middleware and tests.\n\n### Definition of Done\n\n- [ ] Tests updated\n- [ ] Docs updated\n\n### Security or Sensitive Area\n\nYes - auth`;
  const result = evaluateIssue({
    title: '[TASK] Harden auth middleware',
    body,
    labels: ['task'],
  });
  assert.equal(result.decision, 'manual-only');
  assert.ok(result.risks.length > 0);
});

test('placeholder text is rejected', () => {
  const result = evaluateIssue({
    title: '[TASK] Do thing',
    body: '### Objective\n\nTBD\n\n### Scope\n\nTBD\n\n### Definition of Done\n\nTBD',
    labels: ['task'],
  });
  assert.equal(result.decision, 'question');
});

test('buildComment includes triage marker', () => {
  const comment = buildComment({
    decision: 'pass',
    missing: [],
    risks: [],
    reasons: [],
  });
  assert.match(comment, /<!-- triage-human-reviewed -->/);
});

test('isMeaningfulText rejects short placeholder values', () => {
  assert.equal(isMeaningfulText('TBD'), false);
  assert.equal(isMeaningfulText('A sufficiently detailed description'), true);
});

test('detectRiskyScope ignores keywords listed only under Out of scope', () => {
  const body = `### Objective\n\nCorrect one spelling in docs/agent-efficiency/.\n\n### Scope\n\nOne markdown file under docs/agent-efficiency/.\n\n### Out of Scope\n\nProduct code, migrations, infra, auth, and billing.\n\n### Security or Sensitive Area\n\nNo`;
  const sections = parseSections(body);
  const risks = detectRiskyScope('Docs typo', body, sections);
  assert.deepEqual(risks, []);
});

test('detectRiskyScope still flags in-scope auth work when Out of scope excludes it', () => {
  const body = `### Objective\n\nHarden session validation in server auth middleware.\n\n### Scope\n\nserver/auth middleware and tests.\n\n### Out of Scope\n\nFlutter UI only.\n\n### Security or Sensitive Area\n\nNo`;
  const sections = parseSections(body);
  const risks = detectRiskyScope('Auth task', body, sections);
  assert.ok(risks.includes('authentication'));
});

test('detectRiskyScope still honors Security or Sensitive Area: Yes', () => {
  const body = `### Objective\n\nDocument API key rotation.\n\n### Scope\n\nRunbook only.\n\n### Out of Scope\n\nNo code changes.\n\n### Security or Sensitive Area\n\nYes - secrets handling`;
  const sections = parseSections(body);
  const risks = detectRiskyScope('Secrets doc', body, sections);
  assert.ok(risks.includes('declared sensitive/security area'));
});

test('detectRiskyScope scans headingless bodies', () => {
  const body = 'Please change authentication middleware for admin routes without section headings.';
  const risks = detectRiskyScope('Auth tweak', body, {});
  assert.ok(risks.includes('authentication'));
});

test('detectRiskyScope includes non-excluded section headings', () => {
  const body = `### Authentication\n\nNo meaningful change in this section body.\n\n### Out of Scope\n\nBilling and migrations.`;
  const sections = parseSections(body);
  const risks = detectRiskyScope('Task', body, sections);
  assert.ok(risks.includes('authentication'));
});

test('detectRiskyScope scans every in-scope section when headings repeat', () => {
  const body = `### Scope\n\nDocs only.\n\n### Scope\n\nAlso touches authentication hooks in server.`;
  const sections = parseSections(body);
  const risks = detectRiskyScope('Task', body, sections);
  assert.ok(risks.includes('authentication'));
});
