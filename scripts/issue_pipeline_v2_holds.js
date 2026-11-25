'use strict';

/**
 * Pipeline v2 holds (PIPE-V2-D-HOLD-001 to 005). `Blocked` carries two kinds of value:
 *
 *   human holds   question, decision, no-convergence, sensitive, paused: a human must act. Unchanged.
 *   engine holds  stalled, launch-failed: the engine ran out of retries. The engine re-runs the stage
 *                 rule on full facts every tick and releases the hold itself as soon as the rule no
 *                 longer ends in an engine hold (a new merge, a late vote, a merged PR, an agent back
 *                 at work). To hold an issue by hand, use `paused`.
 *
 * Every engine hold the engine sets posts `v2:hold`. A human who clears an engine hold asks for a
 * retry: the next tick posts `v2:release by=human`, and the current stage's attempt markers older
 * than the newest release stop counting. An engine release posts `v2:release by=engine` too.
 */

const ENGINE_HOLDS = new Set(['stalled', 'launch-failed']);
const HOLD = 'v2:hold';
const RELEASE = 'v2:release';
const MARKER = /<!--\s*(v2:[a-z-]+)\b([^>]*)-->/;

/** Engine markers that count attempts in each stage. A release drops those created before it. */
const ATTEMPT_MARKERS = {
  'To do': new Set(['v2:spec-request']),
  'In progress': new Set(['v2:resume', 'v2:aat-relaunch']),
  'In Main': new Set(['v2:aat-launch']),
};

/** Delay before retry number `failures` + 1, from `limits.launchBackoffMin` (the last entry repeats). */
function launchBackoffMs(failures, config) {
  if (!Number.isFinite(failures) || failures < 1) {
    throw new RangeError('launchBackoffMs requires failures >= 1');
  }
  const list = config.limits.launchBackoffMin;
  return list[Math.min(failures, list.length) - 1] * 60 * 1000;
}

function isEngineHold(value) {
  return ENGINE_HOLDS.has(String(value || '').trim().toLowerCase());
}

function markerOf(comment) {
  const match = MARKER.exec(comment?.body || '');
  if (!match) return null;
  const attrs = {};
  for (const pair of match[2].matchAll(/([A-Za-z0-9_]+)=(\S+)/g)) attrs[pair[1]] = pair[2];
  return { name: match[1], attrs };
}

/** Newest engine `v2:hold` and `v2:release`, as `{ hold: { reason, at } | null, releasedAt }`. */
function deriveHoldFacts(comments, engineLogins) {
  const engine = new Set(engineLogins || []);
  let hold = null;
  let releasedAt = null;
  for (const comment of comments || []) {
    if (!engine.has(comment.user?.login)) continue;
    const marker = markerOf(comment);
    const at = Date.parse(comment.created_at);
    if (!marker || !Number.isFinite(at)) continue;
    if (marker.name === HOLD && (!hold || at >= hold.at)) {
      hold = { reason: String(marker.attrs.reason || '').toLowerCase(), at };
    } else if (marker.name === RELEASE && (releasedAt == null || at >= releasedAt)) {
      releasedAt = at;
    }
  }
  return { hold, releasedAt };
}

/** True when the newest engine hold has no release after it: a human cleared it (the field is empty). */
function holdCleared(facts) {
  const hold = facts.holds?.hold;
  if (!hold || facts.blocked) return false;
  const releasedAt = facts.holds.releasedAt;
  return releasedAt == null || releasedAt < hold.at;
}

/**
 * The comments a stage counts attempts from: engine attempt markers created before the newest
 * release are dropped. Everything else, including agent verdicts, is kept.
 */
function sinceRelease(comments, stage, releasedAt, engineLogins) {
  const names = ATTEMPT_MARKERS[stage];
  if (!names || releasedAt == null) return comments;
  const engine = new Set(engineLogins || []);
  return (comments || []).filter((comment) => {
    if (!engine.has(comment.user?.login)) return true;
    const marker = markerOf(comment);
    if (!marker || !names.has(marker.name)) return true;
    return Date.parse(comment.created_at) >= releasedAt;
  });
}

/**
 * An engine-held issue: re-run the stage rule as if unblocked. Still exhausted (an engine hold, or a
 * board-level no-agent wait) → null, and the caller keeps the hold (a human comment still wakes the
 * stage agent). A human hold → that hold replaces it. Anything else → release.
 */
function decideEngineHold(facts, config, decideStage) {
  const hold = String(facts.blocked || '').trim().toLowerCase();
  if (!ENGINE_HOLDS.has(hold)) return null;
  const next = decideStage({ ...facts, blocked: '' }, config);
  if (next.type === 'set-blocked') return ENGINE_HOLDS.has(next.reason) ? null : next;
  if (next.type === 'none' && next.boardError) return null;
  return { type: 'release-hold', by: 'engine', from: hold, cause: next.row || next.reason, row: 'blocked.release' };
}

function buildHold({ reason, row }) {
  return [
    `<!-- ${HOLD} reason=${reason} row=${row} -->`,
    `The engine set \`Blocked: ${reason}\` (${row}). It releases the hold itself when the cause changes, ` +
      'for example a newer merge or an agent back at work. Clearing `Blocked` asks for a retry.',
  ].join('\n');
}

function buildRelease({ by, from, cause }) {
  const marker = `<!-- ${RELEASE} by=${by} from=${from}${cause ? ` cause=${cause}` : ''} -->`;
  const text = by === 'engine'
    ? `The engine released \`Blocked: ${from}\`: the stage rule now says \`${cause}\`. Earlier attempts no longer count.`
    : `\`Blocked: ${from}\` was cleared. The engine retries, and earlier attempts no longer count.`;
  return `${marker}\n${text}`;
}

module.exports = {
  ENGINE_HOLDS,
  ATTEMPT_MARKERS,
  isEngineHold,
  launchBackoffMs,
  deriveHoldFacts,
  holdCleared,
  sinceRelease,
  decideEngineHold,
  buildHold,
  buildRelease,
};
