'use strict';

const { rest } = require('../.github/scripts/github-project-lib');

const SPEC_REQUEST = 'v2:spec-request';
const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function agentLogins(config) {
  return config.agents.map((agent) => agent.login);
}

/**
 * The engine's "spec requested" comment. The marker carries the current assignee and the agents
 * already tried, so a reassignment is an edit of the same comment and the history survives.
 */
function buildSpecRequest({ assigned, history = [] }) {
  return [
    `<!-- ${SPEC_REQUEST} assigned=${assigned} history=${history.join(',')} -->`,
    '## Spec requested',
    '',
    `@${assigned}: draft the missing sections, then check the Definition of Ready ` +
      '(`.cursor/skills/spec-agent/SKILL.md`). React 👍 on this comment when it passes; ' +
      'if you need the owner, post one consolidated question and set `Blocked=question`.',
  ].join('\n');
}

function parseSpecRequest(body) {
  const match = new RegExp(`<!--\\s*${SPEC_REQUEST}\\s+assigned=(\\S*)\\s+history=(\\S*)\\s*-->`).exec(
    String(body || ''),
  );
  if (!match) {
    return null;
  }
  return { assigned: match[1] || null, history: match[2] ? match[2].split(',') : [] };
}

/** Newest spec request written by a trusted engine identity (never by an agent or a stranger). */
function findSpecRequest(comments, engineLogins) {
  const trusted = new Set(engineLogins || []);
  let found = null;
  for (const comment of comments || []) {
    const author = comment?.user?.login;
    const parsed = trusted.has(author) ? parseSpecRequest(comment.body) : null;
    if (parsed && (!found || comment.created_at >= found.comment.created_at)) {
      found = { comment, ...parsed };
    }
  }
  return found;
}

/**
 * Spec facts for `decide()`. `reactions` are the reactions on the request comment; only a 👍
 * from a listed agent created after the request counts as the DoR pass.
 */
function deriveSpecFacts({ comments, reactions, config, engineLogins }) {
  const request = findSpecRequest(comments, engineLogins);
  if (!request) {
    return {};
  }
  const agents = new Set(agentLogins(config));
  const since = Date.parse(request.comment.created_at);
  const passed = (reactions || []).find(
    (reaction) =>
      reaction.content === '+1' &&
      agents.has(reaction.user?.login) &&
      Date.parse(reaction.created_at) >= since,
  );
  return {
    requestedAt: Date.parse(request.comment.updated_at || request.comment.created_at),
    assignedTo: request.assigned,
    timedOut: request.history,
    passedBy: passed ? passed.user.login : null,
    commentId: request.comment.id,
  };
}

/**
 * True when the last comment is from a human with write access (not a listed agent), so a
 * blocked issue should wake its stage agent.
 */
function humanCommentSinceBlock(comments, config) {
  const last = [...(comments || [])].sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
  if (!last) {
    return false;
  }
  const author = last.user?.login;
  return (
    !agentLogins(config).includes(author) &&
    last.user?.type !== 'Bot' &&
    WRITE_ASSOCIATIONS.has(last.author_association)
  );
}

async function listIssueComments({ owner, repo, issueNumber, token, restFn = rest }) {
  return restFn(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments?per_page=100`,
    token,
  );
}

async function listCommentReactions({ owner, repo, commentId, token, restFn = rest }) {
  return restFn(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions?per_page=100`,
    token,
  );
}

module.exports = {
  SPEC_REQUEST,
  buildSpecRequest,
  parseSpecRequest,
  findSpecRequest,
  deriveSpecFacts,
  humanCommentSinceBlock,
  listIssueComments,
  listCommentReactions,
};
