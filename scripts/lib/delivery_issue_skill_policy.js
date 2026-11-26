'use strict';

/**
 * Invariants for `.cursor/skills/delivery-issue/SKILL.md` and the Claude mirror.
 * @module scripts/lib/delivery_issue_skill_policy
 */

const fs = require('fs');
const path = require('path');

const CURSOR_SKILL = '.cursor/skills/delivery-issue/SKILL.md';
const CLAUDE_SKILL = '.claude/skills/delivery-issue/SKILL.md';

const CURSOR_MARKERS = [
  'mission=deliver',
  'disable-model-invocation: true',
  'autonomous-pr-policy.md',
  /§Issue-pipeline delivery PRs/,
  'delivery-issue',
  'finish-work',
  'babysit_pr_reviews.js gate',
];

/** The skill must point at policy, not copy the base-branch driver table. */
const FORBIDDEN_RESTATE = /\|\s*PR base\s*\|\s*Driver\s*\|/;

/** Claude mirror must delegate via one canonical markdown link, not loose substrings. */
const CLAUDE_DELEGATE_LINK =
  /\[[^\]]*\]\(\.\.\/\.\.\/\.\.\/\.cursor\/skills\/delivery-issue\/SKILL\.md\)/;

const CLAUDE_MARKERS = ['Read and follow', 'ScheduleWakeup'];

function markerLabel(marker) {
  if (typeof marker === 'string') return `literal:${marker}`;
  return `/${marker.source}/`;
}

function assertMarkers(text, markers, label) {
  const missing = [];
  for (const marker of markers) {
    if (typeof marker === 'string') {
      if (!text.includes(marker)) missing.push(markerLabel(marker));
    } else if (!marker.test(text)) {
      missing.push(markerLabel(marker));
    }
  }
  if (missing.length) {
    throw new Error(`${label}: missing required marker(s): ${missing.join(', ')}`);
  }
}

function readRepoFile(root, relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`missing file: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
}

/**
 * @param {string} [repoRoot]
 * @returns {{ ok: true }}
 */
function validateDeliveryIssueSkill(repoRoot = path.resolve(__dirname, '../..')) {
  const cursorText = readRepoFile(repoRoot, CURSOR_SKILL);
  assertMarkers(cursorText, CURSOR_MARKERS, CURSOR_SKILL);
  if (FORBIDDEN_RESTATE.test(cursorText)) {
    throw new Error(`${CURSOR_SKILL}: must not restate the issue-pipeline driver table`);
  }

  const claudeText = readRepoFile(repoRoot, CLAUDE_SKILL);
  assertMarkers(claudeText, CLAUDE_MARKERS, CLAUDE_SKILL);
  if (!CLAUDE_DELEGATE_LINK.test(claudeText)) {
    throw new Error(
      `${CLAUDE_SKILL}: must link-delegate to ${CURSOR_SKILL} via ../../../.cursor/skills/delivery-issue/SKILL.md`,
    );
  }

  return { ok: true };
}

module.exports = {
  CURSOR_SKILL,
  CLAUDE_SKILL,
  CLAUDE_DELEGATE_LINK,
  FORBIDDEN_RESTATE,
  validateDeliveryIssueSkill,
};