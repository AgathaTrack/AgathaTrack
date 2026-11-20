'use strict';

/**
 * Pure decision for the prod deploy guard (#2424). No network and no process exit here.
 *
 * AAT_GATE: off (default, no API calls) | dry-run (report only, never fails) | on (fails when a
 * gated candidate is not satisfied). An unknown value is treated as dry-run with a warning, so a
 * typo never blocks a deploy and still shows up in the summary.
 *
 * Which merges are candidates, and whether the gate is enabled at all, is decided by
 * scripts/lib/aat_prod_gate_collect.js from the engine's own rules (#2448).
 */

const MODES = new Set(['off', 'dry-run', 'on']);

/**
 * Plain text for the job summary and workflow-command lines. Values come from GitHub issue fields,
 * API errors and the dispatch input, so anything outside a small safe set (and every newline) is dropped.
 */
function plainText(value, max = 200) {
  return String(value ?? '').replace(/[^A-Za-z0-9 ._,:/#()=+@-]/g, '').slice(0, max);
}

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
 * @param {Array<{number:number, stage:string, mergeSha:string, satisfied:boolean, acceptance:string}>} input.candidates
 *   gated merges already contained in the promoted SHA
 * @param {string} [input.overrideReason] workflow_dispatch override; passes the gate when set
 */
function evaluateProdGate({ mode, candidates, overrideReason = '' }) {
  const wouldBlock = (candidates || [])
    .filter((c) => c.mergeSha && !c.satisfied)
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
  const lines = [`## Deploy PROD — AAT gate (\`AAT_GATE=${plainText(mode, 20)}\`)`, '', `Promoted SHA: \`${plainText(promotedSha, 40)}\``, ''];
  for (const note of notes) {
    lines.push(`- ${plainText(note, 300)}`);
  }
  const list = result.wouldBlock;
  if (list.length === 0) {
    lines.push('- No gated merge in the promoted SHA is waiting on acceptance.');
  } else {
    lines.push('| Issue | Stage | Merge | Acceptance |', '|---|---|---|---|');
    for (const item of list) {
      lines.push(`| #${Number(item.number)} | ${plainText(item.stage, 40)} | \`${plainText(item.mergeSha, 40)}\` | ${plainText(item.acceptance, 40) || 'unset'} |`);
    }
  }
  if (result.override) {
    lines.push('', `Override: ${plainText(result.override, 300)}`);
  }
  lines.push('', result.pass ? 'Result: pass' : 'Result: **blocked**', '');
  return lines.join('\n');
}

module.exports = { MODES, plainText, resolveMode, evaluateProdGate, renderSummary };
