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
 *   - the engine's doorbell launch records: when the current attempt started (not the nonce).
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
 * @param {number|null} [input.releasedAt] newest `v2:release`: when it is newer than the last request,
 *        that round's earlier silent attempts no longer count, so it gets one more attempt (a retry)
 * @returns {Array<object>} rounds for `decideRound`, oldest first
 */
function deriveRoundRecords({ spec, requests = [], verdicts = [], launches = [], bodyHash, releasedAt = null }) {
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

    // Attempts that went silent before the current one are in the request's history. A release after
    // the last request (a human retry) drops them, so the round can be tried again.
    const released = !next && releasedAt != null && releasedAt > request.at;
    for (const id of released ? [] : request.history || []) {
      attempts.push({ type: id, nonce: null, startedAt: request.at, result: 'silent', hashOut: null });
    }

    if (request.assigned) {
      // The body this attempt produces: the next request's hash, or the current body if the round
      // is still the last one and the body has moved since.
      const producedHash = next ? next.hash : bodyHash;
      // A verdict on this request's own hash, or a linked verdict (posted on the edited hash through a
      // confirmed claim, see planRounds): it counts only when it names the hash the attempt produced.
      const verdict = verdicts
        .filter((v) => {
          if (v.agentId !== request.assigned || v.at < request.at) return false;
          if (v.requestHash !== undefined) return v.requestHash === request.hash && v.hash === producedHash;
          return v.hash === request.hash;
        })
        .sort((a, b) => a.at - b.at)[0];
      const launch = launches
        .filter((l) => l.agentId === request.assigned && l.at >= request.at)
        .sort((a, b) => b.at - a.at)[0];
      const attempt = {
        type: request.assigned,
        // The nonce comes only from a verdict. Before one, the launch record is not used: the nonce is
        // the run's identity and is not published until the run votes.
        nonce: verdict?.nonce ?? null,
        startedAt: launch?.at ?? request.at,
        result: null,
        hashOut: null,
      };
      if (verdict?.value === 'up') {
        attempt.result = 'green';
      } else if (verdict?.value === 'down') {
        attempt.result = 'red';
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
