'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const GUIDE = path.join(REPO, 'docs/agent-efficiency/github-issue-workflow-operations.md');
const WORKFLOW = path.join(REPO, '.github/workflows/issue-pipeline-v2.yml');

const ACTIVE_DOC_GLOBS = [
  'docs/agent-efficiency/github-issue-workflow.md',
  'docs/agent-efficiency/github-issue-workflow-behaviour.md',
  'docs/agent-efficiency/github-issue-workflow-wire.md',
  'docs/agent-efficiency/github-issue-workflow-operations.md',
  'docs/agent-efficiency/github-labels.md',
  'docs/agent-efficiency/parallel-programmes.md',
  'docs/agent-efficiency/autonomous-pr-policy.md',
];

/** Active guides must not describe ISSUE_PIPELINE=on as a future cutover (#2560 P4). */
test('active agent-efficiency guides do not plan ISSUE_PIPELINE=on cutover', () => {
  const forbidden = [/ISSUE_PIPELINE=on/, /ISSUE_PIPELINE\s*=\s*['`]on['`]/];
  for (const rel of ACTIVE_DOC_GLOBS) {
    const file = path.join(REPO, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of forbidden) {
      assert.doesNotMatch(
        text,
        pattern,
        `${rel} must not describe v1 ISSUE_PIPELINE=on as planned; use ISSUE_PIPELINE_V2 for cutover`,
      );
    }
  }
});

test('github-issue-workflow lists required pipeline switches (#2560 P4)', () => {
  const text = fs.readFileSync(GUIDE, 'utf8');
  const required = [
    'ISSUE_PIPELINE_V2',
    'ISSUE_PIPELINE_V2_LABEL',
    'WIP_LIMIT',
    'STAGE_MIRROR',
    'WIP_MAX',
    'PIPELINE_IMPLEMENT_LAUNCH',
    'PIPELINE_STUCK_MAX',
    'ISSUE_PIPELINE',
  ];
  for (const name of required) {
    assert.match(text, new RegExp(`\\| \`${name}\` \\|`), `guide must list switch ${name}`);
  }
});

test('issue-pipeline-v2 workflow header points at ISSUE_PIPELINE_V2', () => {
  const head = fs.readFileSync(WORKFLOW, 'utf8').slice(0, 600);
  assert.match(head, /ISSUE_PIPELINE_V2/);
  assert.match(head, /#2560/);
});