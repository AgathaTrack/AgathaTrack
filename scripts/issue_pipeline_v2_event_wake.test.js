'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  shouldWakeFromEvent,
  DEPLOY_WORKFLOW_NAMES,
  RUNNER_WORKFLOW_NAMES,
} = require('./issue_pipeline_v2_event_wake');

const ENGINE = ['pawpet-engine'];
const AGENTS = ['pawpet-bot', 'pawpet-claude'];

const wake = (eventName, payload) => shouldWakeFromEvent({ eventName, payload, engineLogins: ENGINE, agentActsAs: AGENTS });

test('schedule and workflow_dispatch always wake', () => {
  assert.equal(wake('schedule', {}).proceed, true);
  assert.equal(wake('workflow_dispatch', {}).proceed, true);
});

test('issues: skip engine sender, accept humans', () => {
  assert.equal(wake('issues', { sender: { login: 'pawpet-engine' } }).proceed, false);
  assert.equal(wake('issues', { sender: { login: 'KanopeeKa' } }).proceed, true);
});

test('issue_comment: trusted association or agent login', () => {
  assert.equal(
    wake('issue_comment', { comment: { user: { login: 'stranger' }, author_association: 'NONE' } }).proceed,
    false,
  );
  assert.equal(
    wake('issue_comment', { comment: { user: { login: 'stranger' }, author_association: 'MEMBER' } }).proceed,
    true,
  );
  assert.equal(
    wake('issue_comment', { comment: { user: { login: 'pawpet-bot' }, author_association: 'NONE' } }).proceed,
    true,
  );
  assert.equal(
    wake('issue_comment', { comment: { user: { login: 'pawpet-engine' }, author_association: 'MEMBER' } }).proceed,
    false,
  );
});

test('pull_request: merged only', () => {
  assert.equal(wake('pull_request', { pull_request: { merged: true } }).proceed, true);
  assert.equal(wake('pull_request', { pull_request: { merged: false } }).proceed, false);
});

test('workflow_run: successful deploy or claude runner', () => {
  for (const name of DEPLOY_WORKFLOW_NAMES) {
    assert.equal(wake('workflow_run', { workflow_run: { name, conclusion: 'success' } }).proceed, true, name);
  }
  for (const name of RUNNER_WORKFLOW_NAMES) {
    assert.equal(wake('workflow_run', { workflow_run: { name, conclusion: 'success' } }).proceed, true, name);
  }
  assert.equal(
    wake('workflow_run', { workflow_run: { name: 'CI', conclusion: 'success' } }).proceed,
    false,
  );
  assert.equal(
    wake('workflow_run', { workflow_run: { name: 'Deploy UAT (uat.agathatrack.com)', conclusion: 'failure' } }).proceed,
    false,
  );
});

test('issue-pipeline-v2 workflow: switch guard and event triggers (#2560)', () => {
  const workflowPath = path.join(__dirname, '../.github/workflows/issue-pipeline-v2.yml');
  const text = fs.readFileSync(workflowPath, 'utf8');
  assert.match(
    text,
    /wake-gate:[\s\S]*vars\.ISSUE_PIPELINE_V2 == 'dry-run' \|\| vars\.ISSUE_PIPELINE_V2 == 'on'/m,
    'wake gate must be guarded by ISSUE_PIPELINE_V2',
  );
  const tickBlock = text.split('  tick:')[1] || '';
  assert.match(
    tickBlock,
    /needs\.wake-gate\.outputs\.proceed == 'true'/m,
    'tick must depend on wake gate',
  );
  assert.match(text, /issues:\s*\n\s+types:\s*\[edited, labeled, closed, reopened\]/m);
  assert.match(text, /issue_comment:\s*\n\s+types:\s*\[created\]/m);
  assert.match(text, /pull_request:\s*\n\s+types:\s*\[closed\]\s*\n\s+branches:\s*\n\s+-\s+main/m);
  assert.match(text, /workflow_run:\s*\n\s+workflows:\s*\n\s+- Deploy UAT \(uat\.agathatrack\.com\)/m);
  assert.match(text, /- Deploy Production \(agathatrack\.com\)/m);
  assert.match(text, /- Pipeline Claude run/m);
  assert.match(text, /issue_pipeline_v2_event_wake\.js/m);
});