'use strict';

/**
 * Invariants for the babysit skill family: every entry path must require triage,
 * reply, and resolve of all GitHub PR review conversations (reviewThreads) before merge.
 * @module scripts/lib/babysit_skill_family_policy
 */

const fs = require('fs');
const path = require('path');

const POLICY_REL = 'docs/agent-efficiency/autonomous-pr-policy.md';

/** Skills and rules that participate in PR review / merge loops (see policy §Babysit skill family). */
const FAMILY_SKILL_FILES = [
  '.cursor/skills/babysit/SKILL.md',
  '.cursor/skills/babysit-plus/SKILL.md',
  '.cursor/skills/babysit-uat/SKILL.md',
  '.cursor/skills/light-plan/SKILL.md',
  '.cursor/skills/dependabot-batch/SKILL.md',
  '.cursor/skills/execute-plan/SKILL.md',
  '.cursor/rules/pr-hygiene.mdc',
  '.claude/skills/steward/SKILL.md',
];

const POLICY_SECTION_HEADING = '## Babysit skill family';
const DRIVER_ROUTING_HEADING = '### Driver routing';
const MERGE_POLICY_REL = '.cursor/rules/merge-policy.mdc';
const SPAWN_SPRINT_REL = '.cursor/skills/spawn-sprint-agents/SKILL.md';
const WATCHDOG_REL = 'scripts/issue_busy_watchdog.js';
const LIGHT_PLAN_REL = '.cursor/skills/light-plan/SKILL.md';
const BABYSIT_PLUS_REL = '.cursor/skills/babysit-plus/SKILL.md';
const BABYSIT_UAT_REL = '.cursor/skills/babysit-uat/SKILL.md';

/** Must not match "unresolved thread" without a resolve instruction. */
const RESOLVE_ALL_RE =
  /(?:reply\s+on\s+and\s+\*\*resolve\*\*|reply\s*\+\s*resolve|resolve\s+each|resolve\s+every|resolve\s+all|Close every thread|resolve it\.)/i;

/** Canonical policy must name conversations, the gate script, and resolve-all. */
const POLICY_MARKERS = [
  POLICY_SECTION_HEADING,
  /review conversations/i,
  /babysit_pr_reviews\.js/,
  RESOLVE_ALL_RE,
  /doc drift guard|check_babysit_skill_family/i,
];

const GATE_SCRIPT_RE = /babysit_pr_reviews\.js\s+gate/i;

/** Skills that merge via shell babysit (not execute-plan workers). */
const SKILL_MARKERS_WITH_GATE = [GATE_SCRIPT_RE, RESOLVE_ALL_RE, /babysit_pr_reviews\.js/];

/** execute-plan: workers must reply+resolve; driver uses tick ladder (policy table). */
const SKILL_MARKERS_EXECUTE_PLAN = [
  /babysit_pr_reviews\.js/,
  /§Babysit skill family|§Automatic reviews/,
  RESOLVE_ALL_RE,
];

function markerLabel(marker) {
  if (typeof marker === 'string') return `literal:${marker}`;
  const flags = marker.flags.includes('i') ? 'i' : '';
  return `/${marker.source}/${flags}`;
}

function readRepoFile(root, relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`missing file: ${relPath}`);
  }
  return fs.readFileSync(full, 'utf8');
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
  if (missing.length > 0) {
    throw new Error(`${label}: missing required marker(s): ${missing.join(', ')}`);
  }
}

/** §Driver routing invariants (babysit-routing-reconciliation spec §4.8). */
function validateDriverRoutingInvariants(repoRoot) {
  const policyText = readRepoFile(repoRoot, POLICY_REL);
  assertMarkers(
    policyText,
    [
      DRIVER_ROUTING_HEADING,
      '| 2 |',
      '| 12 |',
      '`/babysit-uat` is the driver for rows 2, 4, 8b and 12 only',
    ],
    `${POLICY_REL} §Driver routing`,
  );

  const mergePolicy = readRepoFile(repoRoot, MERGE_POLICY_REL);
  if (mergePolicy.includes('not `/babysit-plus`') || mergePolicy.includes('not **`/babysit-plus`**')) {
    throw new Error(`${MERGE_POLICY_REL}: stale light-plan "not /babysit-plus" wording`);
  }
  if (/\/light-plan`.*\/babysit-uat/i.test(mergePolicy)) {
    throw new Error(`${MERGE_POLICY_REL}: light-plan release must not name /babysit-uat`);
  }

  const lightPlan = readRepoFile(repoRoot, LIGHT_PLAN_REL);
  const releaseIdx = lightPlan.indexOf('## Release');
  if (releaseIdx === -1) {
    throw new Error(`${LIGHT_PLAN_REL}: missing ## Release`);
  }
  const releaseSection = lightPlan.slice(releaseIdx, releaseIdx + 4000);
  if (/Read and follow `\[\`\/babysit-uat|follow `\[\`\/babysit-uat/i.test(releaseSection)) {
    throw new Error(`${LIGHT_PLAN_REL} §Release must not direct to /babysit-uat (row 6 is plus)`);
  }
  assertMarkers(releaseSection, ['§Driver routing row 6', '/babysit-plus'], `${LIGHT_PLAN_REL} §Release`);

  const plusText = readRepoFile(repoRoot, BABYSIT_PLUS_REL);
  const uatText = readRepoFile(repoRoot, BABYSIT_UAT_REL);
  assertMarkers(plusText, [/v2/i, /execute-plan/i, /Driver routing/i], BABYSIT_PLUS_REL);
  assertMarkers(uatText, [/v2/i, /tick`/i, /Driver routing/i], BABYSIT_UAT_REL);

  const spawnText = readRepoFile(repoRoot, SPAWN_SPRINT_REL);
  assertMarkers(spawnText, [/Driver routing row 7/, /row 8b?/], SPAWN_SPRINT_REL);

  const watchdogText = readRepoFile(repoRoot, WATCHDOG_REL);
  assertMarkers(
    watchdogText,
    ['continue light-plan', '`/babysit-plus`'],
    WATCHDOG_REL,
  );
}

/**
 * @param {string} [repoRoot]
 * @returns {{ ok: true, filesChecked: number }}
 */
function validateBabysitSkillFamily(repoRoot = path.resolve(__dirname, '../..')) {
  const policyText = readRepoFile(repoRoot, POLICY_REL);
  assertMarkers(policyText, POLICY_MARKERS, POLICY_REL);

  for (const rel of FAMILY_SKILL_FILES) {
    const text = readRepoFile(repoRoot, rel);
    const markers =
      rel === '.cursor/skills/execute-plan/SKILL.md' ? SKILL_MARKERS_EXECUTE_PLAN : SKILL_MARKERS_WITH_GATE;
    assertMarkers(text, markers, rel);
  }

  validateDriverRoutingInvariants(repoRoot);

  return { ok: true, filesChecked: FAMILY_SKILL_FILES.length + 1 };
}

function copyFamilyFixturesToDir(targetRoot, sourceRoot = path.resolve(__dirname, '../..')) {
  for (const rel of [POLICY_REL, ...FAMILY_SKILL_FILES]) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(targetRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

module.exports = {
  POLICY_REL,
  FAMILY_SKILL_FILES,
  POLICY_SECTION_HEADING,
  DRIVER_ROUTING_HEADING,
  RESOLVE_ALL_RE,
  GATE_SCRIPT_RE,
  validateBabysitSkillFamily,
  validateDriverRoutingInvariants,
  copyFamilyFixturesToDir,
};
