#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  validateDeliveryIssueSkill,
  CURSOR_SKILL,
  FORBIDDEN_RESTATE,
} = require('./lib/delivery_issue_skill_policy');

const REPO_ROOT = path.resolve(__dirname, '..');

function withCopiedSkills(run) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-issue-skill-'));
  try {
    for (const rel of [CURSOR_SKILL, '.claude/skills/delivery-issue/SKILL.md']) {
      const src = path.join(REPO_ROOT, rel);
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
    return run(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('validateDeliveryIssueSkill passes on the live repo', () => {
  assert.deepEqual(validateDeliveryIssueSkill(REPO_ROOT), { ok: true });
});

test('validateDeliveryIssueSkill fails when mission=deliver is removed', () => {
  withCopiedSkills((tmp) => {
    const skillPath = path.join(tmp, CURSOR_SKILL);
    const stripped = fs.readFileSync(skillPath, 'utf8').replaceAll('mission=deliver', '');
    fs.writeFileSync(skillPath, stripped);
    assert.throws(() => validateDeliveryIssueSkill(tmp), /missing required marker/);
  });
});

test('validateDeliveryIssueSkill fails when the driver table is restated', () => {
  withCopiedSkills((tmp) => {
    const skillPath = path.join(tmp, CURSOR_SKILL);
    const text = fs.readFileSync(skillPath, 'utf8');
    fs.writeFileSync(skillPath, `${text}\n| PR base | Driver |\n`);
    assert.throws(() => validateDeliveryIssueSkill(tmp), /must not restate/);
  });
});

test('FORBIDDEN_RESTATE matches driver table rows only', () => {
  assert.equal(FORBIDDEN_RESTATE.test('| PR base | Driver |'), true);
  assert.equal(FORBIDDEN_RESTATE.test('autonomous-pr-policy.md'), false);
});

test('validateDeliveryIssueSkill fails when Claude delegation link is broken', () => {
  withCopiedSkills((tmp) => {
    const skillPath = path.join(tmp, '.claude/skills/delivery-issue/SKILL.md');
    const text = fs.readFileSync(skillPath, 'utf8');
    const broken = text.replace(
      '[`.cursor/skills/delivery-issue/SKILL.md`](../../../.cursor/skills/delivery-issue/SKILL.md)',
      '../../../.cursor/skills/delivery-issue/SKILL.md',
    );
    fs.writeFileSync(skillPath, broken);
    assert.throws(() => validateDeliveryIssueSkill(tmp), /must link-delegate/);
  });
});