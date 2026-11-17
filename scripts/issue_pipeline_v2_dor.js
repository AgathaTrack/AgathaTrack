#!/usr/bin/env node
'use strict';

/**
 * Definition of Ready, mechanical half (#2385 §To do). Pure: body text and labels in, verdict
 * out. The judgement half (single outcome, not a duplicate, no owner-only question) stays with
 * the spec agent.
 *
 * Required sections follow the issue templates in `.github/ISSUE_TEMPLATE`:
 *   task    Summary, Objective, Definition of Done (≥ 1 checkbox), Affected Area
 *   feature Summary, Problem to Solve, Acceptance Criteria (≥ 1 checkbox), Affected Area
 *   bug     Current Behavior, Expected Behavior, Affected Area
 */

const TEMPLATES = {
  task: [
    { section: 'Summary' },
    { section: 'Objective' },
    { section: 'Definition of Done', checkbox: true },
    { section: 'Affected Area' },
  ],
  feature: [
    { section: 'Summary' },
    { section: 'Problem to Solve' },
    { section: 'Acceptance Criteria', checkbox: true },
    { section: 'Affected Area' },
  ],
  bug: [
    { section: 'Current Behavior' },
    { section: 'Expected Behavior' },
    { section: 'Affected Area' },
  ],
};

const CHECKBOX = /^\s*[-*]\s+\[[ xX]\]\s*\S/m;
const EMPTY = /^(?:_?no response_?|n\/a|tbd|todo|\.\.\.)?$/i;

function normalise(heading) {
  return String(heading).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Split an issue body on its `###` headings (the shape GitHub issue forms render). */
function parseSections(body) {
  const sections = new Map();
  let current = null;
  let fence = false;
  for (const line of String(body || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
    }
    const heading = !fence && /^###\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = normalise(heading[1]);
      if (!sections.has(current)) {
        sections.set(current, []);
      }
    } else if (current) {
      sections.get(current).push(line);
    }
  }
  return new Map([...sections].map(([name, lines]) => [name, lines.join('\n').trim()]));
}

function detectTemplate(labels, sections) {
  const set = new Set((labels || []).map((label) => String(label).toLowerCase()));
  for (const name of ['task', 'feature', 'bug']) {
    if (set.has(name)) {
      return name;
    }
  }
  if (sections.has('definition of done') || sections.has('objective')) return 'task';
  if (sections.has('acceptance criteria') || sections.has('problem to solve')) return 'feature';
  if (sections.has('current behavior') || sections.has('expected behavior')) return 'bug';
  return null;
}

/**
 * @returns {{ ok: boolean, template: string|null, missing: Array<{section: string, reason: string}> }}
 */
function checkDor(body, labels = []) {
  const sections = parseSections(body);
  const template = detectTemplate(labels, sections);
  if (!template) {
    return { ok: false, template: null, missing: [{ section: '(template)', reason: 'unknown-template' }] };
  }
  const missing = [];
  for (const rule of TEMPLATES[template]) {
    const text = sections.get(normalise(rule.section));
    if (text === undefined) {
      missing.push({ section: rule.section, reason: 'absent' });
    } else if (EMPTY.test(text)) {
      missing.push({ section: rule.section, reason: 'empty' });
    } else if (rule.checkbox && !CHECKBOX.test(text)) {
      missing.push({ section: rule.section, reason: 'no-checkbox' });
    }
  }
  return { ok: missing.length === 0, template, missing };
}

function main() {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const read = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : args[at + 1];
  };
  const file = read('--body-file');
  if (!file) {
    console.error('usage: issue_pipeline_v2_dor.js --body-file <path> [--labels a,b]');
    process.exit(2);
  }
  const labels = (read('--labels') || '').split(',').filter(Boolean);
  const result = checkDor(fs.readFileSync(file, 'utf8'), labels);
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { TEMPLATES, parseSections, detectTemplate, checkDor };
