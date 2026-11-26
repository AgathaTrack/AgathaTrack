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
 *   - the assignee's edit in that round (`edit`, from a launch-verified claim): the new hash it
 *     produced, and the proof of who produced it;
 *   - verified signed review verdicts (`up` / `down`) on that request's own hash;
 *   - the engine's doorbell launch records: when the current attempt started (not the nonce).
 *
 * Rules (PIPE-V2-D-REV4-001, -002):
 *   - an edit closes the round: the assignee is the run that produced `edit.hash`, and it posts no
 *     verdict for that version. The round's attempt is `red` with `hashOut` set, which decideRound
 *     reads as "closed by an edit";
 *   - a `down` with the body still on the same hash holds the round (`red`, no `hashOut`);
 *   - an `up` on the request's own hash is `green`;
 *   - a body hash that no attempt produced was written by a human (no author recorded).
 *
 * Rounds 1 to 3 after the spec are tier a (R2 to R4); later reviews are tier b (C1 to C4).
 */

/**
 * @param {object} input
 * @param {{author: string|null, hash: string|null}|null} input.spec   the spec pass; author null = human
 * @param {Array<{hash: string, assigned: string|null, history: string[], at: number, edit: {hash: string, at: number}|null}>} input.requests
 *        review requests, oldest first; `assigned` and `history` are agent ids; `edit` is the assignee's edit in this round
 * @param {Array<{agentId: string, value: string, hash: string, nonce: string, at: number}>} input.verdicts
 *        verified review verdicts on request hashes (value 'up' | 'down')
 * @param {Array<{agentId: string, nonce: string|null, at: number}>} input.launches
 *        doorbell launches for the In analysis stage
 * @param {number|null} [input.releasedAt] newest `v2:release`: when it is newer than the last request,
 *        that round's earlier silent attempts no longer count, so it gets one more attempt (a retry)
 * @returns {Array<object>} rounds for `decideRound`, oldest first
 */
function deriveRoundRecords({ spec, requests = [], verdicts = [], launches = [], releasedAt = null }) {
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
      const launch = launches
        .filter((l) => l.agentId === request.assigned && l.at >= request.at)
        .sort((a, b) => b.at - a.at)[0];
      const attempt = {
        type: request.assigned,
        nonce: null,
        startedAt: launch?.at ?? request.at,
        result: null,
        hashOut: null,
      };
      if (request.edit) {
        // The edit is the approval of the version it produced. It closes the round and posts no verdict.
        attempt.result = 'red';
        attempt.hashOut = request.edit.hash;
      } else {
        // Only a signed verdict on this request's own hash, from the assignee, counts.
        const verdict = verdicts
          .filter((v) => v.agentId === request.assigned && v.at >= request.at && v.hash === request.hash)
          .sort((a, b) => a.at - b.at)[0];
        // The nonce comes only from a verdict. Before one, the launch record is not used: the nonce is
        // the run's identity and is not published until the run votes.
        attempt.nonce = verdict?.nonce ?? null;
        if (verdict?.value === 'up') attempt.result = 'green';
        else if (verdict?.value === 'down') attempt.result = 'red';
      }
      attempts.push(attempt);
    }

    rounds.push({ tier, kind: 'review', hashIn: request.hash, attempts });
  });

  return rounds;
}

module.exports = { deriveRoundRecords };
