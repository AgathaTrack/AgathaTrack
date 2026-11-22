'use strict';

/**
 * Review process v3, P4 dry-run adapter: builds the round plan for one In analysis issue from the
 * comments the tick already reads. Returns the `decideRound` answer and the round count. It writes
 * nothing; the tick logs the plan next to the live action so the two can be compared.
 */

const { findVerifiedVerdicts } = require('./issue_pipeline_v2_verdict');
const { parseLaunchComment } = require('./issue_pipeline_v2_launch');
const { deriveSpecFacts } = require('./issue_pipeline_v2_comments');
const { resolveAgent } = require('./issue_pipeline_v2_config');
const { findReviewRequests } = require('./issue_pipeline_v2_review');
const { deriveRoundRecords } = require('./issue_pipeline_v2_round_facts');
const { decideRound } = require('./issue_pipeline_v2_rounds');

/**
 * @returns {{plan: object, rounds: number}|null} null when there is nothing to plan yet (no spec pass)
 */
function planRounds({ comments, config, engineLogins, editors, bodyHash, issueNumber, limits, now }) {
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

  const launchRecords = (comments || []).map((c) => parseLaunchComment(c)).filter((r) => r && r.kind === 'launch' && r.agent);
  const doorbells = launchRecords.filter((r) => r.purpose === 'doorbell');
  const launches = doorbells
    .filter((r) => r.stage === 'In analysis')
    .map((r) => ({ agentId: idOf(r.agent), nonce: r.nonce, at: r.at }));
  const lastUsed = {};
  for (const r of doorbells) {
    const id = idOf(r.agent);
    lastUsed[id] = Math.max(lastUsed[id] ?? -Infinity, r.at);
  }

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
