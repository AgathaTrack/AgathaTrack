'use strict';

/**
 * Review process v3, P4: the round decision function (pure; callers log dry-run vs live).
 *
 * Model (PIPE-V2-D-REV3-002 to 005, review-process-v3 §5 to §8):
 * - A type (`cursor-a`, `claude-a`, `cursor-b`, `claude-b`) is who gets called. Every call starts
 *   a new run with a new nonce. A run is who voted.
 * - Tier a rounds: R1 is the spec (writes the body and passes the Definition of Ready); R2, R3, R4
 *   are reviews. Tier b rounds: C1 to C4, reviews. The tier follows the review count, not the result:
 *   the second review (R3) is followed by tier a (R4); after the three tier-a reviews the next is tier b.
 *   A tier-a review that ends in an edit (its approval) is therefore followed by the first tier-b review.
 * - Alternation: the next type is the least recently used candidate in the tier whose brand differs
 *   from the author of the current body. With no other brand left, the same brand repeats and the
 *   round is `fallback=true`. A human author has no brand, so any candidate is eligible.
 * - One green on the current hash converges when it comes from a run other than the run that wrote
 *   the hash. An edit by the reviewer is its approval: it closes the round and the next round starts on
 *   the edited hash, with another run. A down without an edit holds the round on the same hash until
 *   the reviewer edits or the silence timeout fires.
 * - Budgets: three reviews in tier a (R2 to R4), then four in tier b (C1 to C4). A red on C4 is
 *   `no-convergence`. A round with two failed attempts is `stalled`.
 * - Authorship comes from the round record (the run that produced each hash), never from a login.
 *
 * Input (all plain data; nothing touches GitHub):
 *   bodyHash    hash of the current body
 *   rounds      ordered list, oldest first. Each round:
 *                 { tier: 'a' | 'b', kind: 'spec' | 'review', hashIn,
 *                   attempts: [{ type, nonce, startedAt, result, hashOut }] }
 *               result is one of 'spec' (spec pass), 'green', 'red' (a down hold, or closed by an
 *               edit when hashOut is set), or null while the run is pending. `hashOut` is the body
 *               hash the attempt produced (spec and edit); null otherwise.
 *   now         epoch ms
 *   lastUsed    { [type]: epoch ms } of the last doorbell per type (board-wide), for round robin
 *   config      loadConfig() result
 *
 * Output: one action, `{ type: 'request-round' | 'set-stage' | 'set-blocked' | 'none', ... }`.
 */

const MIN = 60 * 1000;

function brandOf(config, id) {
  const entry = (config.agents || []).find((agent) => agent.id === id);
  return entry ? entry.runner : null;
}

/**
 * Effective state of one attempt at `now`. A pending run or a red without an edit becomes `silent`
 * once `timeoutMs` has passed since it started. A red with an edit is `red-edit` only when its
 * `hashOut` differs from the round's `hashIn`.
 */
function attemptState(round, attempt, now, timeoutMs) {
  if (attempt.result === 'spec') return 'spec';
  if (attempt.result === 'green') return 'green';
  if (attempt.result === 'silent') return 'silent';
  const expired = now - attempt.startedAt >= timeoutMs;
  if (attempt.result === 'red') {
    if (attempt.hashOut && attempt.hashOut !== round.hashIn) return 'red-edit';
    return expired ? 'silent' : 'red-hold';
  }
  // result null: the run has not answered
  return expired ? 'silent' : 'pending';
}

/** Startable ids in a tier: the pool a round can draw from. */
function tierPool(config, tier) {
  const startable = new Set(config.launchRunners || []);
  return (config.agents || [])
    .filter((agent) => agent.runner && startable.has(agent.runner))
    .filter((agent) => (agent.tier || 'a') === tier)
    .map((agent) => agent.id);
}

/** Author of the current body: the run that produced `bodyHash`, or a human when none did. */
function authorOf(rounds, bodyHash) {
  for (let r = rounds.length - 1; r >= 0; r -= 1) {
    const attempts = rounds[r].attempts;
    for (let a = attempts.length - 1; a >= 0; a -= 1) {
      if (attempts[a].hashOut && attempts[a].hashOut === bodyHash) {
        // A spec pass with no known writer (type null) is a human author.
        if (!attempts[a].type) return { human: true, type: null, nonce: null, brand: null };
        return { human: false, type: attempts[a].type, nonce: attempts[a].nonce, brand: null };
      }
    }
  }
  return { human: true, type: null, nonce: null, brand: null };
}

/**
 * Consecutive failed attempts by one identity in one tier, newest last. Two in a row make it down.
 * A failure is a `silent` attempt at `now`.
 */
function isDown(rounds, tier, id, now, timeoutMs) {
  const history = [];
  for (const round of rounds) {
    if (round.tier !== tier) continue;
    for (const attempt of round.attempts) {
      if (attempt.type === id) history.push(attemptState(round, attempt, now, timeoutMs));
    }
  }
  let trailing = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === 'silent'; i -= 1) trailing += 1;
  return trailing >= 2;
}

/**
 * Next type for a round. Candidates are the startable tier-a or tier-b ids that are not down and
 * not in `excluded`. Alternation first; then the same brand (fallback); a human author allows any.
 */
function selectType({ config, tier, prevBrand, excluded, rounds, lastUsed, now, timeoutMs }) {
  const startable = new Set(config.launchRunners || []);
  const pool = (config.agents || [])
    .filter((agent) => agent.runner && startable.has(agent.runner))
    .filter((agent) => (agent.tier || 'a') === tier)
    .map((agent) => agent.id)
    .filter((id) => !excluded.includes(id))
    .filter((id) => !isDown(rounds, tier, id, now, timeoutMs));
  if (pool.length === 0) return null;
  const leastRecent = (ids) =>
    ids.reduce((best, id) => {
      const at = lastUsed[id] ?? -Infinity;
      return best === null || at < (lastUsed[best] ?? -Infinity) ? id : best;
    }, null);
  const pick = (agent, fallback) => ({ agent, brand: brandOf(config, agent), fallback });
  if (!prevBrand) return pick(leastRecent(pool), false);
  const other = pool.filter((id) => brandOf(config, id) !== prevBrand);
  if (other.length > 0) return pick(leastRecent(other), false);
  return pick(leastRecent(pool), true);
}

/**
 * `silenceMs` is how long the holder may stay silent (default reviewTimeoutMin; the live caller doubles
 * it while `busy`, as soak-6 did). `holderFailed` means the holder's doorbell did not start.
 */
function decideRound({ bodyHash, rounds, now, lastUsed = {}, config, silenceMs, holderFailed = false }) {
  const timeoutMs = silenceMs ?? config.limits.reviewTimeoutMin * MIN;
  if (!rounds || rounds.length === 0) {
    return { type: 'none', reason: 'analysis.no-spec' };
  }
  const last = rounds[rounds.length - 1];
  const lastAttempt = last.attempts[last.attempts.length - 1];
  const state = attemptState(last, lastAttempt, now, timeoutMs);
  const author = authorOf(rounds, bodyHash);
  const prevBrand = author.human ? null : brandOf(config, author.type);

  // A holder outside the round's tier pool (a tier-b id on a tier-a round, or one that cannot be
  // started) is not waited for and its verdict does not count: it is reassigned at once (REV3-004).
  const holderOut = holderFailed || (Boolean(lastAttempt.type) && !tierPool(config, last.tier).includes(lastAttempt.type));

  // 1. Convergence: one green on the current hash, from a run other than the one that wrote it,
  //    and from a pool identity.
  if (last.kind === 'review' && state === 'green' && !holderOut && last.hashIn === bodyHash) {
    // Only compare nonces that are known; an unknown nonce cannot prove the same run.
    if (!author.human && lastAttempt.nonce && author.nonce && lastAttempt.nonce === author.nonce) {
      return { type: 'none', reason: 'analysis.green-by-author-ignored' };
    }
    return {
      type: 'set-stage',
      to: 'Ready',
      row: 'analysis.converged',
      evidence: { hash: bodyHash, approvedBy: lastAttempt.type, nonce: lastAttempt.nonce },
    };
  }

  // 2. The last round is still open on the current hash.
  const effective = holderOut && ['pending', 'red-hold', 'green'].includes(state) ? 'silent' : state;
  const open = last.hashIn === bodyHash && ['pending', 'red-hold', 'silent'].includes(effective);
  if (open) {
    if (effective === 'pending' || effective === 'red-hold') {
      return { type: 'none', reason: 'analysis.round-waiting' };
    }
    // silent: retry the same round once, with a type that has not tried it yet.
    if (last.attempts.length < 2) {
      const tried = last.attempts.map((attempt) => attempt.type);
      const next = selectType({ config, tier: last.tier, prevBrand, excluded: tried, rounds, lastUsed, now, timeoutMs });
      if (!next) return { type: 'set-blocked', reason: 'stalled', row: 'analysis.round-stalled' };
      return {
        type: 'request-round',
        tier: last.tier,
        round: roundLabel(rounds.slice(0, -1), last.tier),
        hash: bodyHash,
        attempt: last.attempts.length + 1,
        ...next,
        row: 'analysis.round-retry',
        failureClass: holderFailed ? 'ring-failed' : holderOut ? 'not-startable' : 'timeout',
      };
    }
    return { type: 'set-blocked', reason: 'stalled', row: 'analysis.round-failed' };
  }

  // 3. The last round is closed (red with edit, spec, or a stale hash): start the next one.
  const reviewsA = rounds.filter((round) => round.tier === 'a' && round.kind === 'review').length;
  const reviewsB = rounds.filter((round) => round.tier === 'b' && round.kind === 'review').length;
  let tier;
  if (reviewsA < 3) {
    tier = 'a';
  } else if (reviewsB < 4) {
    tier = 'b';
  } else {
    return { type: 'set-blocked', reason: 'no-convergence', row: 'analysis.no-convergence' };
  }
  const next = selectType({ config, tier, prevBrand, excluded: [], rounds, lastUsed, now, timeoutMs });
  if (!next) return { type: 'set-blocked', reason: 'stalled', row: 'analysis.no-candidate' };
  return {
    type: 'request-round',
    tier,
    round: roundLabel(rounds, tier),
    hash: bodyHash,
    attempt: 1,
    ...next,
    row: tier === 'b' ? 'challenge.round-request' : 'analysis.round-request',
  };
}

/** R2..R4 in tier a, C1..C4 in tier b, counted from the reviews already in the list. */
function roundLabel(rounds, tier) {
  const reviews = rounds.filter((round) => round.tier === tier && round.kind === 'review').length;
  return tier === 'a' ? `R${reviews + 2}` : `C${reviews + 1}`;
}

/**
 * The board's round-robin cursor as recency: the next id after `after` is the least recent, so
 * least-recently-used picks it first, as `nextInLine` did. Ids further on the ring are more recent.
 */
function cursorLastUsed(order, after) {
  const at = after ? order.indexOf(after) : -1;
  if (at < 0) return {};
  const n = order.length;
  const used = {};
  order.forEach((id, i) => {
    const ahead = (i - at + n) % n; // 0 = the cursor itself, 1 = next in line
    used[id] = ahead === 0 ? 0 : -(n - ahead);
  });
  return used;
}

module.exports = { decideRound, attemptState, authorOf, isDown, selectType, roundLabel, cursorLastUsed };
