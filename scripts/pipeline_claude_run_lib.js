'use strict';

/**
 * Shared helpers for `pipeline-claude-run.yml` (#2428 §9): the prepare step names the engine
 * request comment the run answers, and the verify step checks the run left a trace on the issue.
 *
 * Why the verify step exists (soak-6, #2485): a Claude run that ends without a vote, a question or
 * a comment still finishes `success`. The runner adapter then reports `finished`, which is not a
 * failed ring, so the pickup waits out the timeout with `busy` set. Failing the job instead makes
 * `status()` return `failed`, and the next live tick reassigns at once (`ringFailed`).
 */

/** The engine comment a doorbell stage answers. Stages without one (acceptance) have no reaction. */
const REQUEST_MARKERS = {
  'To do': 'v2:spec-request',
  'In analysis': 'v2:review-request',
  'In Main': 'v2:intent-review',
};

/** Allowed clock drift between the runner and GitHub timestamps. */
const SKEW_MS = 60 * 1000;

/**
 * `<!--` then optional whitespace, then `marker` as a whole token. String scan, not a RegExp built
 * from the marker: the marker is a fixed token and must not be interpreted as a pattern.
 */
function bodyHasRequestMarker(body, marker) {
  const text = String(body || '');
  const token = String(marker || '');
  if (!token) {
    return false;
  }
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf('<!--', from);
    if (start < 0) {
      return false;
    }
    let i = start + 4;
    while (i < text.length && /\s/.test(text[i])) {
      i += 1;
    }
    if (text.startsWith(token, i)) {
      const after = text[i + token.length];
      if (!after || !/[\w-]/.test(after)) {
        return true;
      }
    }
    from = start + 4;
  }
  return false;
}

function findRequestComment({ comments, stage, engineLogins }) {
  const marker = REQUEST_MARKERS[stage];
  if (!marker) {
    return null;
  }
  const engine = new Set(engineLogins || []);
  return (
    (comments || [])
      .filter((comment) => engine.has(comment.user?.login) && bodyHasRequestMarker(comment.body, marker))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .at(-1) || null
  );
}

/** Prompt lines naming the request comment and the exact command to vote on it. */
function reactionHint({ owner, repo, stage, commentId }) {
  if (!commentId) {
    return '';
  }
  const path = `repos/${owner}/${repo}/issues/comments/${commentId}/reactions`;
  const up = `\`gh api -X POST ${path} -f content=+1\``;
  const down = `\`gh api -X POST ${path} -f content=-1\``;
  const vote = stage === 'In analysis' ? `Vote with ${up} (👍) or ${down} (👎).` : `React 👍 with ${up}.`;
  return [
    `The engine request comment for this stage is id ${commentId}. ${vote}`,
    'Your reaction or your comment is how the engine sees the result. A run that leaves neither on this issue is reported as failed and the issue is handed to another agent.',
  ].join(' ');
}

/**
 * Did the run leave something the engine (or a human) can act on? A comment by the run's login,
 * or a reaction by it on the request comment, posted after the run started.
 */
function runEvidence({ comments, reactions, actsAs, sinceMs }) {
  const login = String(actsAs || '').toLowerCase();
  const after = (iso) => Date.parse(iso) >= sinceMs - SKEW_MS;
  const comment = (comments || []).find(
    (entry) => String(entry.user?.login || '').toLowerCase() === login && after(entry.created_at),
  );
  if (comment) {
    return { ok: true, evidence: `comment ${comment.id}` };
  }
  const reaction = (reactions || []).find(
    (entry) =>
      String(entry.user?.login || '').toLowerCase() === login &&
      ['+1', '-1'].includes(entry.content) &&
      after(entry.created_at),
  );
  if (reaction) {
    return { ok: true, evidence: `reaction ${reaction.content}` };
  }
  return { ok: false, evidence: null };
}

/**
 * `claude_args` for claude-code-action: the allowed tools, plus `--model` when the identity names a
 * model. The model comes from the reviewed config and was validated by loadConfig; it is never read
 * from the dispatch inputs.
 */
function buildClaudeArgs(agent) {
  const base = '--allowedTools Bash,Edit,Write,Read,Glob,Grep';
  const model = agent && typeof agent.model === 'string' ? agent.model : '';
  if (!model) {
    return base;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new Error(`refusing unsafe model name for claude_args: ${model}`);
  }
  return `${base} --model ${model}`;
}

module.exports = {
  REQUEST_MARKERS,
  SKEW_MS,
  bodyHasRequestMarker,
  findRequestComment,
  reactionHint,
  runEvidence,
  buildClaudeArgs,
};
