'use strict';

/**
 * Review process v3, P4 dry-run adapter: builds the round plan for one In analysis issue from the
 * comments the tick already reads. Returns the `decideRound` answer and the round count. It writes
 * nothing; the tick logs the plan next to the live action so the two can be compared.
 */

const { findVerifiedVerdicts, findConfirmedClaims } = require('./issue_pipeline_v2_verdict');
const { parseLaunchComment } = require('./issue_pipeline_v2_launch');
const { deriveSpecFacts } = require('./issue_pipeline_v2_comments');
const { findReviewRequests } = require('./issue_pipeline_v2_review');
const { deriveRoundRecords } = require('./issue_pipeline_v2_round_facts');
const { decideRound, cursorLastUsed } = require('./issue_pipeline_v2_rounds');
const { resolveAgent, startableIds } = require('./issue_pipeline_v2_config');

/**
 * @returns {{plan: object, rounds: number}|null} null when there is nothing to plan yet (no spec pass)
 */
function planRounds({ comments, config, engineLogins, editors, bodyHash, issueNumber, limits, now, roundRobinAfter, roundRobinOrder }) {
  const requests = findReviewRequests(comments, engineLogins, editors);
  const idOf = (value) => (value ? resolveAgent(config, value)?.id || value : null);

  const specProbe = deriveSpecFacts({ comments, reactions: [], config, engineLogins, editors, issueNumber, bodyHash, limits, now });
  // Before the first review request the spec pass is the body the first review will read.
  const spec = { author: idOf(specProbe.assignedTo), hash: requests[0]?.parsed.hash ?? bodyHash };

  // Verified verdicts for each request hash. The verifier only accepts a verdict on the hash it is given.
  const verdicts = [];
  for (const request of requests) {
    for (const v of findVerifiedVerdicts({
      comments,
      config,
      engineLogins,
      issueNumber,
      bodyHash: request.parsed.hash,
      limits,
      kinds: ['review'],
    })) {
      verdicts.push({ agentId: v.agentId, value: v.value, hash: v.hash, nonce: v.nonce, at: v.at });
    }
  }

  // A red with an edit posts its verdict on the new hash. That verdict answers the request it came
  // from only through the edit claim: the assignee's confirmed claim, made after this request and
  // before the next one, names the new hash. Neither hash alone links it.
  const claims = findConfirmedClaims({ comments, config, engineLogins, limits });
  requests.forEach((request, i) => {
    const assignee = idOf(request.parsed.assigned);
    const from = Date.parse(request.comment.updated_at || request.comment.created_at);
    const next = requests[i + 1];
    const until = next ? Date.parse(next.comment.updated_at || next.comment.created_at) : Infinity;
    for (const claim of claims) {
      if (claim.agentId !== assignee || claim.hash === request.parsed.hash) continue;
      if (claim.at < from || claim.at >= until) continue;
      for (const v of findVerifiedVerdicts({
        comments,
        config,
        engineLogins,
        issueNumber,
        bodyHash: claim.hash,
        limits,
        kinds: ['review'],
      })) {
        // A late verdict from the old run must not attach to this request once the next one has started.
        if (v.agentId !== claim.agentId || v.at < claim.at || v.at >= until) continue;
        verdicts.push({ agentId: v.agentId, value: v.value, hash: v.hash, nonce: v.nonce, at: v.at, requestHash: request.parsed.hash });
      }
    }
  });

  const launchRecords = (comments || []).map((c) => parseLaunchComment(c)).filter((r) => r && r.kind === 'launch' && r.agent);
  const doorbells = launchRecords.filter((r) => r.purpose === 'doorbell');
  const launches = doorbells
    .filter((r) => r.stage === 'In analysis')
    .map((r) => ({ agentId: idOf(r.agent), nonce: r.nonce, at: r.at }));
  // The same recency the live action uses: the board's round-robin cursor (PIPE-V2-D-SOAK-006).
  const lastUsed = cursorLastUsed(roundRobinOrder || startableIds(config), roundRobinAfter);

  const requestsIn = requests.map((request) => ({
    hash: request.parsed.hash,
    assigned: idOf(request.parsed.assigned),
    history: (request.parsed.history || []).map(idOf),
    at: Date.parse(request.comment.updated_at || request.comment.created_at),
  }));
  const rounds = deriveRoundRecords({ spec, requests: requestsIn, verdicts, launches, bodyHash });
  const plan = decideRound({ bodyHash, rounds, now, lastUsed, config });
  return { plan, rounds: rounds.length, reviews: rounds.filter((r) => r.kind === 'review').length, derived: rounds };
}

module.exports = { planRounds };
