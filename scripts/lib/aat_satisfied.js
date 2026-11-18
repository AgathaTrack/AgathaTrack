'use strict';

/**
 * Acceptance (AAT) predicate shared by the prod guard (#2424) and the In Main gate (#2448).
 * Pure: callers pass the issue comments they already fetched; nothing here touches the network.
 *
 * Rule for one merge sha (#2448 §aatSatisfied): satisfied when the newest actionable verdict for
 * that sha is `pass`, or the human `Acceptance` value is `manual` / `skipped` and an engine waive
 * comment binds that same kind to that sha. A bare `Passed`, `Failed` or `Pending` value is never
 * satisfaction on its own.
 */

const FAIL_REASONS = new Set(['scope', 'implementation', 'quality']);
const VERDICTS = new Set(['pass', 'fail', 'inconclusive']);
const WAIVE_KINDS = new Set(['manual', 'skipped']);

// The marker is the last line of a comment. `v2:aat` is the verdict; `v2:aat-launch` and
// `v2:aat-waive` are engine comments. Other `v2:aat-*` markers are not read here.
const MARKER_LINE = /^<!--\s*(v2:aat(?:-launch|-waive)?)\s+(.*?)\s*-->$/;

function parseAttrs(text) {
  const attrs = {};
  for (const match of String(text).matchAll(/([a-z-]+)=(\S+)/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

/** `{ name, attrs }` for a marker comment, or null. */
function parseAatMarker(body) {
  const lastLine = String(body || '').trim().split('\n').pop().trim();
  const match = MARKER_LINE.exec(lastLine);
  if (!match) {
    return null;
  }
  return { name: match[1], attrs: parseAttrs(match[2]) };
}

/**
 * Facts for one merge sha from the issue's comments (oldest first).
 *
 * - launch: the engine's latest `v2:aat-launch` for the sha. Without one, no verdict counts.
 * - verdict: the newest actionable verdict for the sha: listed author, newer than that launch,
 *   and a `fail` carries a known reason. Inconclusive is kept as a verdict but is not `pass`.
 * - waives: the waive kinds (`manual`, `skipped`) the engine bound to the sha.
 */
function deriveAatFacts({ comments, mergeSha, listedAgents, engineLogins }) {
  const agents = new Set(listedAgents || []);
  const engine = new Set(engineLogins || []);
  const parsed = (comments || []).map((comment, index) => ({
    index,
    login: comment.user?.login || '',
    marker: parseAatMarker(comment.body),
  }));

  let launchIndex = -1;
  for (const item of parsed) {
    const { marker } = item;
    if (marker?.name === 'v2:aat-launch' && marker.attrs.merge === mergeSha && engine.has(item.login)) {
      launchIndex = item.index;
    }
  }

  let verdict = null;
  const waives = new Set();
  for (const item of parsed) {
    const { marker } = item;
    if (!marker || !mergeSha) {
      continue;
    }
    if (marker.name === 'v2:aat-waive') {
      if (engine.has(item.login) && marker.attrs.merge === mergeSha && WAIVE_KINDS.has(marker.attrs.acceptance)) {
        waives.add(marker.attrs.acceptance);
      }
      continue;
    }
    if (marker.name !== 'v2:aat') {
      continue;
    }
    const { attrs } = marker;
    if (!agents.has(item.login) || attrs.merge !== mergeSha) {
      continue;
    }
    if (launchIndex < 0 || item.index <= launchIndex) {
      continue;
    }
    if (!VERDICTS.has(attrs.verdict)) {
      continue;
    }
    if (attrs.verdict === 'fail' && !FAIL_REASONS.has(attrs.reason)) {
      continue;
    }
    verdict = { verdict: attrs.verdict, reason: attrs.reason || null };
  }

  return { launchIndex, verdict, waives };
}

/** @returns {boolean} Whether the merge `mergeSha` has an acceptance outcome that lets it ship. */
function aatSatisfied({ acceptance, mergeSha, verdict, waives }) {
  if (!mergeSha) {
    return false;
  }
  if (verdict?.verdict === 'pass') {
    return true;
  }
  const field = String(acceptance || '').trim().toLowerCase();
  if (WAIVE_KINDS.has(field)) {
    return Boolean(waives && waives.has(field));
  }
  return false;
}

module.exports = {
  FAIL_REASONS,
  parseAatMarker,
  deriveAatFacts,
  aatSatisfied,
};
