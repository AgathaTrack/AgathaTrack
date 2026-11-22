'use strict';

/**
 * Review process v3, P4 wiring: derive round records from what the engine already keeps, for
 * `decideRound` (`issue_pipeline_v2_rounds.js`). Pure: the caller passes in parsed comments and
 * verified verdicts. Nothing here writes to GitHub.
 *
 * Sources, all already on the issue:
 *   - the spec pass (R1): the spec writer and the body hash it produced;
 *   - each `v2:review-request hash=<h>` comment: one round, starting on that hash. A reassignment
 *     edits the same comment, so its `history` lists the attempts that went silent before the
 *     current one;
 *   - verified signed review verdicts (`up` / `down`) on that request's hash: they carry the run's
 *     nonce and identity;
 *   - the engine's doorbell launch records: when the current attempt started, and its nonce if no
 *     verdict has arrived.
 *
 * Rules from PIPE-V2-D-REV3-005 and -006:
 *   - a `down` that is followed by a new request on a new hash is a red with an edit: that
 *     attempt's `hashOut` is the new hash, and its run is the author of it;
 *   - a `down` with the body still on the same hash is a red without an edit: it holds the round;
 *   - a body hash that no attempt produced was written by a human.
 *
 * Rounds 1 to 3 after the spec are tier a (R2 to R4); later reviews are tier b (C1 to C4).
 */

/**
 * @param {object} input
 * @param {{author: string|null, hash: string|null}|null} input.spec   the spec pass; author null = human
 * @param {Array<{hash: string, assigned: string|null, history: string[], at: number}>} input.requests
 *        review requests, oldest first; `assigned` and `history` are agent ids
 * @param {Array<{agentId: string, value: string, hash: string, nonce: string, at: number}>} input.verdicts
 *        verified review verdicts (value 'up' | 'down'); `value` as the verifier returns it
 * @param {Array<{agentId: string, nonce: string|null, at: number}>} input.launches
 *        doorbell launches for the In analysis stage
 * @param {string} input.bodyHash current body hash
 * @returns {Array<object>} rounds for `decideRound`, oldest first
 */
function deriveRoundRecords({ spec, requests = [], verdicts = [], launches = [], bodyHash }) {
  const rounds = [];
  if (spec && spec.hash) {
    rounds.push({
      tier: 'a',
      kind: 'spec',
      hashIn: null,
      attempts: [{ type: spec.author ?? null, nonce: null, startedAt: null, result: 'spec', hashOut: spec.hash }],
    });
  }

  let reviewIndex = 0;
  requests.forEach((request, i) => {
    reviewIndex += 1;
    const tier = reviewIndex <= 3 ? 'a' : 'b';
    const next = requests[i + 1];
    const attempts = [];

    // Attempts that went silent before the current one are in the request's history.
    for (const id of request.history || []) {
      attempts.push({ type: id, nonce: null, startedAt: request.at, result: 'silent', hashOut: null });
    }

    if (request.assigned) {
      const verdict = verdicts
        .filter((v) => v.agentId === request.assigned && v.hash === request.hash && v.at >= request.at)
        .sort((a, b) => a.at - b.at)[0];
      const launch = launches
        .filter((l) => l.agentId === request.assigned && l.at >= request.at)
        .sort((a, b) => b.at - a.at)[0];
      const attempt = {
        type: request.assigned,
        nonce: verdict?.nonce ?? launch?.nonce ?? null,
        startedAt: launch?.at ?? request.at,
        result: null,
        hashOut: null,
      };
      if (verdict?.value === 'up') {
        attempt.result = 'green';
      } else if (verdict?.value === 'down') {
        attempt.result = 'red';
        // The body this red produced: the next request's hash, or the current body if the
        // round is still the last one and the body has moved since.
        const producedHash = next ? next.hash : bodyHash;
        if (producedHash && producedHash !== request.hash) {
          attempt.hashOut = producedHash;
        }
      }
      attempts.push(attempt);
    }

    rounds.push({ tier, kind: 'review', hashIn: request.hash, attempts });
  });

  return rounds;
}

module.exports = { deriveRoundRecords };
