'use strict';

const { rest } = require('../.github/scripts/github-project-lib');
const { agentLogins, resolveAgent, isSharedActsAs, entryActsAs } = require('./issue_pipeline_v2_config');
const { findVerifiedVerdicts } = require('./issue_pipeline_v2_verdict');

const SPEC_REQUEST = 'v2:spec-request';
const WRITE_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * The engine's "spec requested" comment. The marker carries the current assignee and the agents
 * already tried, so a reassignment is an edit of the same comment and the history survives.
 */
function buildSpecRequest({ assigned, history = [], config }) {
  const entry = config ? resolveAgent(config, assigned) : null;
  const id = entry?.id || assigned;
  const mention = entry?.actsAs || assigned;
  return [
    `<!-- ${SPEC_REQUEST} assigned=${id} history=${history.join(',')} -->`,
    '## Spec requested',
    '',
    `@${mention}: draft the missing sections, then check the Definition of Ready ` +
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

/**
 * A request comment is trusted when an engine identity wrote it and nobody else edited it. An
 * edited comment needs its last editor (`editors[node_id]`, from GraphQL) to be its author; a
 * comment whose editor is unknown is not trusted.
 */
function isTrustedRequest(comment, engineLogins, editors = {}) {
  const author = comment?.user?.login;
  if (!author || !(engineLogins || []).includes(author)) {
    return false;
  }
  if (!comment.updated_at || comment.updated_at === comment.created_at) {
    return true;
  }
  return editors[comment.node_id] === author;
}

/** Newest spec request written by a trusted engine identity (never by an agent or a stranger). */
function findSpecRequest(comments, engineLogins, editors = {}) {
  let found = null;
  for (const comment of comments || []) {
    const parsed = isTrustedRequest(comment, engineLogins, editors) ? parseSpecRequest(comment.body) : null;
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
function deriveSpecFacts({
  comments,
  reactions,
  config,
  engineLogins,
  editors,
  issueNumber,
  bodyHash,
  voteKey,
  limits,
  now,
}) {
  const request = findSpecRequest(comments, engineLogins, editors);
  if (!request) {
    return {};
  }
  const since = Date.parse(request.comment.created_at);
  const assignedTo = resolveAgent(config, request.assigned)?.id || request.assigned;
  const timedOut = (request.history || []).map((entry) => resolveAgent(config, entry)?.id || entry);
  let passedBy = null;
  const assignedEntry = resolveAgent(config, request.assigned);
  const assignedActsAs = assignedEntry ? entryActsAs(assignedEntry) : request.assigned;
  const assigneeNeedsSigned = isSharedActsAs(config, assignedActsAs);
  if (assigneeNeedsSigned && !voteKey) {
    passedBy = null;
  } else if (assigneeNeedsSigned && voteKey && bodyHash && issueNumber) {
    const specUp = findVerifiedVerdicts({
      comments,
      config,
      engineLogins,
      issueNumber,
      bodyHash,
      voteKey,
      limits,
      now,
      kinds: ['spec'],
      sinceMs: since,
    }).filter((verdict) => verdict.value === 'up');
    if (specUp.length > 0) {
      passedBy = specUp.at(-1).actsAs;
    }
  } else {
    const agents = new Set(agentLogins(config));
    const passed = (reactions || []).find(
      (reaction) =>
        reaction.content === '+1' &&
        agents.has(reaction.user?.login) &&
        !isSharedActsAs(config, reaction.user?.login) &&
        Date.parse(reaction.created_at) >= since,
    );
    passedBy = passed ? passed.user.login : null;
  }
  return {
    requestedAt: Date.parse(request.comment.updated_at || request.comment.created_at),
    assignedTo,
    timedOut,
    passedBy,
    commentId: request.comment.id,
  };
}

/**
 * True when a human with write access commented after the last comment by a listed agent or the
 * engine, so a blocked issue should wake its stage agent. Humans are write-access users who are
 * neither listed agents, nor the engine identity, nor bots. There is no block timestamp in the
 * data the engine reads, so the last agent or engine comment is the anchor; run B records which
 * comment it already woke the agent for, so one reply wakes it once.
 */
function humanCommentsSinceBlock(comments, config) {
  const agents = new Set(agentLogins(config));
  const engine = new Set(config.engine?.logins || []);
  const sorted = [...(comments || [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const isMachine = (comment) => agents.has(comment.user?.login) || engine.has(comment.user?.login);
  let anchor = -1;
  sorted.forEach((comment, index) => {
    if (isMachine(comment)) {
      anchor = index;
    }
  });
  return sorted
    .slice(anchor + 1)
    .filter((comment) => comment.user?.type !== 'Bot' && WRITE_ASSOCIATIONS.has(comment.author_association));
}

function humanCommentSinceBlock(comments, config) {
  return humanCommentsSinceBlock(comments, config).length > 0;
}

/** The newest qualifying human comment (what a wake answers), or null. */
function latestHumanComment(comments, config) {
  return humanCommentsSinceBlock(comments, config).pop() || null;
}

const WAKE = 'v2:wake';

/** The engine's "wake" note; the marker records which human comment it answered. */
function buildWake({ commentId, agent, config }) {
  const mention = config ? resolveAgent(config, agent)?.actsAs || agent : agent;
  return [
    `<!-- ${WAKE} comment=${commentId} -->`,
    `@${mention}: the owner or a maintainer replied above. Re-read the issue and continue; you may clear \`Blocked\` once you have what you need.`,
  ].join('\n');
}

/** Ids of human comments the engine already woke an agent for. */
function wokenCommentIds(comments, engineLogins) {
  const engine = new Set(engineLogins || []);
  const ids = [];
  for (const comment of comments || []) {
    const match = engine.has(comment.user?.login)
      ? new RegExp(`<!--\\s*${WAKE}\\s+comment=(\\d+)\\s*-->`).exec(comment.body || '')
      : null;
    if (match) {
      ids.push(Number(match[1]));
    }
  }
  return ids;
}

/**
 * Read every page of a REST list. A page shorter than `perPage` is the last one; `maxPages`
 * bounds a runaway (30 pages = 3000 items, far beyond any real issue).
 */
async function fetchAllPages({ path, token, restFn = rest, perPage = 100, maxPages = 30 }) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await restFn('GET', `${path}?per_page=${perPage}&page=${page}`, token);
    all.push(...(batch || []));
    if (!batch || batch.length < perPage) {
      break;
    }
  }
  return all;
}

async function listIssueComments({ owner, repo, issueNumber, token, restFn = rest }) {
  return fetchAllPages({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`,
    token,
    restFn,
  });
}

async function listCommentReactions({ owner, repo, commentId, token, restFn = rest }) {
  return fetchAllPages({
    path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${commentId}/reactions`,
    token,
    restFn,
  });
}

module.exports = {
  SPEC_REQUEST,
  buildSpecRequest,
  parseSpecRequest,
  isTrustedRequest,
  findSpecRequest,
  deriveSpecFacts,
  humanCommentSinceBlock,
  latestHumanComment,
  buildWake,
  wokenCommentIds,
  WAKE,
  fetchAllPages,
  listIssueComments,
  listCommentReactions,
};
