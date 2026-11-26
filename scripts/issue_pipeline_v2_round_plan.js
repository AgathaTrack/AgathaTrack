'use strict';

/**
 * Review process v3, P4 round plan: builds the round records and the `decideRound` answer for one
 * In analysis issue from the comments the tick already reads. Writes nothing.
 *
 * Counting rules (PIPE-V2-D-REV4-001, -002):
 *   - only a signed verdict on the hash its request names counts as a vote;
 *   - an edit by the assignee (a launch-verified claim in the request's window) is its approval of
 *     the new version: it closes the round, produces the new hash, and posts no verdict;
 *   - a verdict by a run on a hash that run produced is a self-vote: it is not counted, and it is
 *     returned in `ignored` so the tick can log it.
 */

const { findVerifiedVerdicts, findLaunchVerifiedClaims } = require('./issue_pipeline_v2_verdict');
const { parseLaunchComment } = require('./issue_pipeline_v2_launch');
const { deriveSpecFacts } = require('./issue_pipeline_v2_comments');
const { findReviewRequests } = require('./issue_pipeline_v2_review');
const { deriveRoundRecords } = require('./issue_pipeline_v2_round_facts');
const { decideRound, cursorLastUsed } = require('./issue_pipeline_v2_rounds');
const { resolveAgent, startableIds } = require('./issue_pipeline_v2_config');

/**
 * @returns {{plan: object, rounds: number, reviews: number, derived: object[], ignored: object[]}}
 */
function planRounds({ comments, config, engineLogins, editors, bodyHash, issueNumber, limits, now, roundRobinAfter, roundRobinOrder, releasedAt = null }) {
  const requests = findReviewRequests(comments, engineLogins, editors);
  const idOf = (value) => (value ? resolveAgent(config, value)?.id || value : null);

  const specProbe = deriveSpecFacts({ comments, reactions: [], config, engineLogins, editors, issueNumber, bodyHash, limits, now });
  // Before the first review request the spec pass is the body the first review will read.
  const spec = { author: idOf(specProbe.assignedTo), hash: requests[0]?.parsed.hash ?? bodyHash };

  // The assignee's edit in its request's window, when it changed the body. The first such claim is the
  // edit; a later one belongs to a later request. A claim by anyone else, or after the next request, is not this round's.
  const claims = findLaunchVerifiedClaims({ comments, config, engineLogins, limits });
  const requestsIn = requests.map((request, i) => {
    const assignee = idOf(request.parsed.assigned);
    const from = Date.parse(request.comment.updated_at || request.comment.created_at);
    const next = requests[i + 1];
    const until = next ? Date.parse(next.comment.updated_at || next.comment.created_at) : Infinity;
    const edit = claims
      .filter((claim) => claim.agentId === assignee && claim.hash !== request.parsed.hash && claim.at >= from && claim.at < until)
      .sort((a, b) => a.at - b.at)[0];
    return {
      hash: request.parsed.hash,
      assigned: assignee,
      history: (request.parsed.history || []).map(idOf),
      at: from,
      edit: edit ? { hash: edit.hash, at: edit.at, commit: edit.commit } : null,
    };
  });

  // Self-votes: a verdict by the same run that produced a hash, on that hash. The run is identified by its
  // commitment (sha256 of its nonce, equal to the commit of its launch and of its edit claim), not by its agent id:
  // a later run of the same identity (fallback) is a different run, and its verdict counts. Not counted; logged.
  const ignored = [];
  const selfRuns = new Set();
  for (const request of requestsIn) {
    if (!request.edit) continue;
    selfRuns.add(`${request.edit.hash}|${request.edit.commit}`);
    for (const v of findVerifiedVerdicts({ comments, config, engineLogins, issueNumber, bodyHash: request.edit.hash, limits, kinds: ['review'] })) {
      if (v.commit === request.edit.commit && v.at >= request.edit.at) {
        ignored.push({ agentId: v.agentId, hash: request.edit.hash, value: v.value, reason: 'self-vote' });
      }
    }
  }

  // Signed verdicts on each request's own hash. The verifier accepts a verdict only on the hash given.
  // A self-vote is dropped here, so the round records never count it.
  const verdicts = [];
  for (const request of requests) {
    for (const v of findVerifiedVerdicts({ comments, config, engineLogins, issueNumber, bodyHash: request.parsed.hash, limits, kinds: ['review'] })) {
      if (selfRuns.has(`${v.hash}|${v.commit}`)) continue;
      verdicts.push({ agentId: v.agentId, value: v.value, hash: v.hash, nonce: v.nonce, at: v.at });
    }
  }

  const launchRecords = (comments || []).map((c) => parseLaunchComment(c)).filter((r) => r && r.kind === 'launch' && r.agent);
  const doorbells = launchRecords.filter((r) => r.purpose === 'doorbell');
  const launches = doorbells
    .filter((r) => r.stage === 'In analysis')
    .map((r) => ({ agentId: idOf(r.agent), nonce: r.nonce, at: r.at }));
  // The same recency the live action uses: the board's round-robin cursor (PIPE-V2-D-SOAK-006).
  const lastUsed = cursorLastUsed(roundRobinOrder || startableIds(config), roundRobinAfter);

  const rounds = deriveRoundRecords({ spec, requests: requestsIn, verdicts, launches, releasedAt });
  const plan = decideRound({ bodyHash, rounds, now, lastUsed, config });
  return { plan, rounds: rounds.length, reviews: rounds.filter((r) => r.kind === 'review').length, derived: rounds, ignored };
}

module.exports = { planRounds };
