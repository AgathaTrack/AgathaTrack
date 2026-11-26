'use strict';

const { isTrustedRequest } = require('./issue_pipeline_v2_comments');
const { agentLogins, resolveAgent, isSharedActsAs } = require('./issue_pipeline_v2_config');
const { findVerifiedVerdicts, findConfirmedClaims } = require('./issue_pipeline_v2_verdict');

const REVIEW_REQUEST = 'v2:review-request';

/**
 * The engine's "review requested for <hash>" comment (#2385 §In Analysis). One per body hash; a
 * reassignment edits the same comment, and the marker keeps the agents already tried.
 */
function buildReviewRequest({ hash, assigned, history = [], config }) {
  const entry = assigned && config ? resolveAgent(config, assigned) : null;
  const id = entry?.id || assigned || '';
  const mention = entry?.actsAs || assigned;
  return [
    `<!-- ${REVIEW_REQUEST} hash=${hash} assigned=${id} history=${history.join(',')} -->`,
    `## Review requested for \`${hash}\``,
    '',
    assigned
      ? `@${mention}: review this version of the issue (\`.cursor/skills/review-agent/SKILL.md\`).`
      : 'Waiting for a reviewer.',
    '',
    'Listed agents vote with a signed verdict only: `node scripts/pipeline_verdict.js review up|down --hash <hash>`, ' +
    'as the last action of a run. An edit to the body is that run\'s approval and takes no verdict. ' +
    'Reactions are not votes, from anyone, and the owner\'s reactions are not votes either.',
  ].join('\n');
}

function parseReviewRequest(body) {
  const match = new RegExp(
    `<!--\\s*${REVIEW_REQUEST}\\s+hash=(\\S+)\\s+assigned=(\\S*)\\s+history=(\\S*)\\s*-->`,
  ).exec(String(body || ''));
  if (!match) {
    return null;
  }
  return { hash: match[1], assigned: match[2] || null, history: match[3] ? match[3].split(',') : [] };
}

/** Trusted review requests, oldest first. */
function findReviewRequests(comments, engineLogins, editors = {}) {
  return (comments || [])
    .filter((comment) => isTrustedRequest(comment, engineLogins, editors))
    .map((comment) => ({ comment, parsed: parseReviewRequest(comment.body) }))
    .filter((entry) => entry.parsed)
    .sort((a, b) => a.comment.created_at.localeCompare(b.comment.created_at));
}

/**
 * Votes on one request. Reactions are never votes (PIPE-V2-D-REV4-001): a vote is a signed verdict, read by
 * `findVerifiedVerdicts`. Returns no votes; the signature is kept so the callers' shape does not change.
 */
function votesOnRequest() {
  return [];
}

/**
 * Review facts for `decide()`:
 *   review          newest request (hash, time, assignee, agents tried) and every vote on every hash
 *   lastBodyEditor  editor of the newest body edit, else the issue author
 *   totalVotes      votes cast since the issue entered In analysis (the first trusted request):
 *                   one per listed agent per request hash, plus agent body edits after it
 */
function deriveReviewFacts({
  comments,
  reactionsByComment,
  edits,
  bodyAuthor,
  config,
  engineLogins,
  editors,
  issueNumber,
  bodyHash,
  limits,
  now,
}) {
  const requests = findReviewRequests(comments, engineLogins, editors);
  const agents = new Set(agentLogins(config));
  const lastEdit = (edits || [])[edits.length - 1];
  const lastBodyEditor = lastEdit ? lastEdit.editor : bodyAuthor || null;
  if (requests.length === 0) {
    return { review: {}, lastBodyEditor, totalVotes: 0 };
  }
  const votes = [];
  const enteredAt = Date.parse(requests[0].comment.created_at);
  for (const request of requests) {
    votes.push(
      ...votesOnRequest({ request, reactions: reactionsByComment?.[request.comment.id], config }).filter(
        // A shared login cannot name its voter, so its reactions are never votes (PIPE-V2-D-P2-001).
        (vote) => !isSharedActsAs(config, vote.login),
      ),
    );
  }
  // Every signed review verdict since the issue entered In analysis counts toward the vote cap, on whichever
  // body hash it names ("votes cast since the issue entered In analysis"), not only the current hash.
  const verdictHashes = [...new Set([...requests.map((request) => request.parsed.hash), bodyHash].filter(Boolean))];
  for (const hash of verdictHashes) {
    if (!issueNumber) break;
    for (const verdict of findVerifiedVerdicts({
      comments,
      config,
      engineLogins,
      issueNumber,
      bodyHash: hash,
      limits,
      kinds: ['review'],
      sinceMs: enteredAt,
    })) {
      if (verdict.kind !== 'review') {
        continue;
      }
      const vote = verdict.value === 'up' ? 'up' : verdict.value === 'down' ? 'down' : null;
      if (!vote) {
        continue;
      }
      votes.push({
        login: verdict.actsAs,
        agentId: verdict.agentId,
        vote,
        hash: verdict.hash,
        at: verdict.at,
      });
    }
  }
  let editorAgentId = null;
  if (bodyHash && issueNumber) {
    // D16: a claim on the current hash, confirmed by its run's verdict, following the newest edit by
    // the identity's login.
    const editClaims = findConfirmedClaims({ comments, config, engineLogins, limits }).filter(
      (claim) =>
        claim.hash === bodyHash &&
        lastEdit &&
        String(lastEdit.editor || '').toLowerCase() === String(claim.actsAs).toLowerCase() &&
        claim.at >= Date.parse(lastEdit.editedAt),
    );
    if (editClaims.length > 0) {
      editorAgentId = editClaims.at(-1).agentId;
    }
  }
  const newest = requests[requests.length - 1];
  const agentEdits = (edits || []).filter(
    (edit) => agents.has(edit.editor) && Date.parse(edit.editedAt) >= enteredAt,
  ).length;
  const assignedTo = resolveAgent(config, newest.parsed.assigned)?.id || newest.parsed.assigned;
  const timedOut = (newest.parsed.history || []).map((entry) => resolveAgent(config, entry)?.id || entry);
  return {
    review: {
      requestedHash: newest.parsed.hash,
      requestedAt: Date.parse(newest.comment.updated_at || newest.comment.created_at),
      assignedTo,
      timedOut,
      votes,
      commentId: newest.comment.id,
    },
    lastBodyEditor,
    editorAgentId,
    totalVotes: votes.length + agentEdits,
  };
}

module.exports = {
  REVIEW_REQUEST,
  buildReviewRequest,
  parseReviewRequest,
  findReviewRequests,
  votesOnRequest,
  deriveReviewFacts,
};
