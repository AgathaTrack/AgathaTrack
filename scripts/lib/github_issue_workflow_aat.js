'use strict';

const AAT_LABELS = {
  progress: 'AAT-progress',
  passed: 'AAT-passed',
  failed: 'AAT-failed',
};

const AAT_MARKER = 'v2:aat';

/** @param {'start'|'pass'|'fail'|'inconclusive'} outcome */
function aatLabelPlan(outcome) {
  const all = [AAT_LABELS.progress, AAT_LABELS.passed, AAT_LABELS.failed];
  if (outcome === 'inconclusive') {
    return { add: [], remove: all };
  }
  let add;
  if (outcome === 'start') add = [AAT_LABELS.progress];
  else if (outcome === 'pass') add = [AAT_LABELS.passed];
  else if (outcome === 'fail') add = [AAT_LABELS.failed];
  else throw new Error(`unknown AAT outcome: ${outcome}`);
  const remove = all.filter((l) => !add.includes(l));
  return { add, remove };
}

/** @param {'pass'|'fail'|'inconclusive'} verdict */
function buildAatMarker(verdict, mergeSha) {
  const sha = validateMergeSha(mergeSha);
  return `<!-- ${AAT_MARKER} verdict=${verdict} merge=${sha} -->`;
}

function appendAatMarker(body, verdict, mergeSha) {
  const marker = buildAatMarker(verdict, mergeSha);
  const trimmed = String(body || '').trimEnd();
  return trimmed ? `${trimmed}\n\n${marker}\n` : `${marker}\n`;
}

function validateMergeSha(sha) {
  const normalized = String(sha || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`invalid or missing merge SHA: ${sha || '(empty)'}`);
  }
  return normalized;
}

/**
 * @param {Array<{merged?: boolean, base?: string, mergedAt?: string|null, mergeSha?: string|null}>} prs
 */
function lastMainMergeShaFromLinkedPrs(prs) {
  const merges = (prs || [])
    .filter((pr) => pr.merged && pr.base === 'main')
    .sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  return validateMergeSha(merges.at(-1)?.mergeSha);
}

module.exports = {
  AAT_LABELS,
  AAT_MARKER,
  aatLabelPlan,
  buildAatMarker,
  appendAatMarker,
  validateMergeSha,
  lastMainMergeShaFromLinkedPrs,
};