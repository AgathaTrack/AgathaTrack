'use strict';

/**
 * Pure decision for the prod deploy guard (#2424). No network and no process exit here.
 *
 * AAT_GATE: off (default, no API calls) | dry-run (report only, never fails) | on (fails when a
 * candidate is not satisfied). An unknown value is treated as dry-run with a warning, so a typo
 * never blocks a deploy and still shows up in the summary.
 */

const MODES = new Set(['off', 'dry-run', 'on']);
// Stages whose latest merge must be accepted before prod: a merge is in scope once it is in UAT.
const GATED_STAGES = new Set(['In Main', 'In UAT']);

function resolveMode(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) {
    return { mode: 'off', warning: null };
  }
  if (MODES.has(value)) {
    return { mode: value, warning: null };
  }
  return {
    mode: 'dry-run',
    warning: `AAT_GATE="${raw}" is not off, dry-run or on; running as dry-run`,
  };
}

/**
 * @param {object} input
 * @param {string} input.mode resolved mode (not off)
 * @param {Array<{number:number, stage:string, mergeSha:string|null, inScope:boolean, satisfied:boolean, acceptance:string}>} input.candidates
 * @param {string} [input.overrideReason] workflow_dispatch override; passes the gate when set
 */
function evaluateProdGate({ mode, candidates, overrideReason = '' }) {
  const wouldBlock = (candidates || [])
    .filter((c) => GATED_STAGES.has(c.stage) && c.mergeSha && c.inScope && !c.satisfied)
    .map(({ number, stage, mergeSha, acceptance }) => ({ number, stage, mergeSha, acceptance: acceptance || '' }));
  const override = String(overrideReason || '').trim();

  if (mode === 'dry-run') {
    return { mode, pass: true, blocking: [], overridden: [], wouldBlock, override: '' };
  }
  if (override) {
    return { mode, pass: true, blocking: [], overridden: wouldBlock, wouldBlock, override };
  }
  return {
    mode,
    pass: wouldBlock.length === 0,
    blocking: wouldBlock,
    overridden: [],
    wouldBlock,
    override: '',
  };
}

function renderSummary({ mode, promotedSha, result, notes = [] }) {
  const lines = [`## Deploy PROD — AAT gate (\`AAT_GATE=${mode}\`)`, '', `Promoted SHA: \`${promotedSha}\``, ''];
  for (const note of notes) {
    lines.push(`- ${note}`);
  }
  const list = result.wouldBlock;
  if (list.length === 0) {
    lines.push('- No engine-owned merge in scope is waiting on acceptance.');
  } else {
    lines.push('| Issue | Stage | Merge | Acceptance |', '|---|---|---|---|');
    for (const item of list) {
      lines.push(`| #${item.number} | ${item.stage} | \`${item.mergeSha}\` | ${item.acceptance || 'unset'} |`);
    }
  }
  if (result.override) {
    lines.push('', `Override: ${result.override}`);
  }
  lines.push('', result.pass ? 'Result: pass' : 'Result: **blocked**', '');
  return lines.join('\n');
}

module.exports = { MODES, GATED_STAGES, resolveMode, evaluateProdGate, renderSummary };
