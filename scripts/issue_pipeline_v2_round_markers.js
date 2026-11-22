'use strict';

/**
 * Review process v3, P3: round markers. The engine writes one comment per round event so every
 * attempt, failure and close is on the issue, with the failure class when there is one.
 *
 * Record (engine-authored, hidden marker plus one visible line):
 *   <!-- v2:round event=<start|queued|fail|close> round=<R1|R2..R4|C1..C4> tier=<a|b>
 *        identity=<type> brand=<cursor|claude> attempt=<n> fallback=<true|false> hash=<hash>
 *        author=<type|human|none> [failure=<class>] [verdict=<value>] [runid=<id>] -->
 *
 * Events:
 *   start   a doorbell run was started for this identity (runid is audit data; the nonce is never
 *           written to a marker, because it would publish the run's identity at launch)
 *   queued  the runner cap deferred the doorbell; no attempt has started yet
 *   fail    an attempt failed; `failure` is one of FAILURE_CLASSES
 *   close   the round ended: `verdict` is converged, spec, stalled, no-convergence, or a green/red
 *
 * The markers are read by `parseRoundMarker`, and by P4's derivation once it moves off comment
 * parsing. Nothing decides on them today.
 */

const FAILURE_CLASSES = new Set(['timeout', 'ring-failed', 'not-startable']);
const EVENTS = new Set(['start', 'queued', 'fail', 'close']);
const MARKER = /<!--\s*v2:round\s+([^>]*?)\s*-->/;
const KEYS = ['event', 'round', 'tier', 'identity', 'brand', 'attempt', 'fallback', 'hash', 'author', 'failure', 'verdict', 'runid'];

/**
 * The round label for review number `k` (1 = the first review after the spec): R2 to R4 in tier a,
 * then C1 to C4 in tier b. The spec round is R1. `null` when `k` is unknown.
 */
function roundFor(k) {
  if (!Number.isInteger(k) || k < 1) return null;
  return k <= 3 ? { tier: 'a', round: `R${k + 1}` } : { tier: 'b', round: `C${k - 3}` };
}

/** Attribute values may hold letters, digits and `._:-` only; anything else is dropped. */
function clean(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).replace(/[^\w.:-]/g, '');
}

/** Visible line and hidden marker for one round event. Unknown fields are left out. */
function buildRoundMarker(fields) {
  const event = fields.event;
  if (!EVENTS.has(event)) throw new Error(`round marker: unknown event ${event}`);
  if (event === 'fail' && !FAILURE_CLASSES.has(fields.failure)) {
    throw new Error(`round marker: fail needs a failure class from ${[...FAILURE_CLASSES].join(', ')}`);
  }
  const values = {
    event,
    round: clean(fields.round),
    tier: clean(fields.tier),
    identity: clean(fields.identity),
    brand: clean(fields.brand),
    attempt: fields.attempt === undefined ? null : clean(fields.attempt),
    fallback: fields.fallback === undefined ? null : clean(Boolean(fields.fallback)),
    hash: clean(fields.hash),
    author: clean(fields.author),
    failure: clean(fields.failure),
    verdict: clean(fields.verdict),
    runid: clean(fields.runId),
  };
  const attrs = KEYS.filter((key) => values[key] !== null).map((key) => `${key}=${values[key]}`);
  const who = values.identity ? `${values.identity}${values.brand ? ` (${values.brand})` : ''}` : 'no identity';
  const what = {
    start: `started ${who}`,
    queued: `queued ${who}; the runner cap deferred the doorbell`,
    fail: `attempt failed: ${values.failure}${values.identity ? `, ${who}` : ''}`,
    close: `closed${values.verdict ? `: ${values.verdict}` : ''}`,
  }[event];
  const label = values.round ? `Round ${values.round}${values.attempt ? `, attempt ${values.attempt}` : ''}: ` : '';
  return [`<!-- v2:round ${attrs.join(' ')} -->`, `${label}${what}.`].join('\n');
}

/** The record as an object, or null when the body has no round marker. */
function parseRoundMarker(body) {
  const match = MARKER.exec(String(body || ''));
  if (!match) return null;
  const out = {};
  for (const pair of match[1].split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    if (KEYS.includes(key)) out[key] = pair.slice(eq + 1);
  }
  if (out.attempt !== undefined) out.attempt = Number(out.attempt);
  if (out.fallback !== undefined) out.fallback = out.fallback === 'true';
  if (out.runid !== undefined) out.runId = out.runid;
  return out;
}

module.exports = { buildRoundMarker, parseRoundMarker, roundFor, FAILURE_CLASSES, EVENTS };
