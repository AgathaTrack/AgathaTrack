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

const { METHOD_PROMPTS, fillPrompt } = require('./issue_pipeline_v2_launch');

/** Stages with a doorbell task prompt; delivery uses METHOD_PROMPTS instead. */
const DOORBELL_STAGES = new Set(['To do', 'In analysis', 'In Main', 'acceptance']);

/** A full commit sha, the only form a `merge_sha` input may take. */
const MERGE_SHA = /^[0-9a-f]{40}$/;

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
function escapeToken(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Did this run leave a trace on the issue since it started?
 *
 * - Unique login (`shared` false): a comment or a 👍/👎 by that login after the start.
 * - Shared login (`shared` true, e.g. the Claude pair on pawpet-claude): only a signed verdict
 *   that names this run, `agent=<agentId>` and `nonce=<nonce>`. A sibling identity's comment or
 *   reaction on the same login is not evidence of this run.
 */
function runEvidence({ comments, reactions, actsAs, agentId, nonce, shared = false, sinceMs }) {
  const login = String(actsAs || '').toLowerCase();
  const after = (iso) => Date.parse(iso) >= sinceMs - SKEW_MS;
  if (shared) {
    if (!agentId || !nonce) {
      return { ok: false, evidence: null, reason: 'shared login: run identity and nonce are required' };
    }
    const named = new RegExp(`agent=${escapeToken(agentId)}\\s+nonce=${escapeToken(nonce)}(\\s|-->)`);
    const verdict = (comments || []).find(
      (entry) =>
        String(entry.user?.login || '').toLowerCase() === login && after(entry.created_at) && named.test(entry.body || ''),
    );
    return verdict
      ? { ok: true, evidence: `verdict ${verdict.id}` }
      : { ok: false, evidence: null, reason: 'no verdict naming this run' };
  }
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

/**
 * The task text for the run. An acceptance task names the merge it judges. A run with no valid merge
 * is refused before it starts, so it never verifies a placeholder or a merge it was not given.
 */
function buildStageTask({ stage, method, prompts, number, mergeSha, mergeDir }) {
  if (stage === 'babysit') {
    return METHOD_PROMPTS.PR;
  }
  if (stage && DOORBELL_STAGES.has(stage)) {
    if (stage === 'acceptance') {
      if (!MERGE_SHA.test(String(mergeSha || ''))) {
        throw new Error('acceptance run has no valid merge_sha; refusing to start without the merge it judges');
      }
      if (!mergeDir) {
        throw new Error('acceptance run has no checkout of the merge under test; refusing to start');
      }
      const task = fillPrompt(prompts[stage], { number, mergeSha });
      return `${task}\n\nThe merge under test is checked out at ${mergeDir}. Read the behaviour there and do not edit it.`;
    }
    return fillPrompt(prompts[stage], { number, mergeSha });
  }
  return METHOD_PROMPTS[method];
}

const AAT_VERDICT = /<!--\s*v2:aat\s+verdict=(?:pass|fail|inconclusive)\b([^>]*)-->/;
const AAT_MERGE = /\bmerge=([0-9a-f]{40})\b/;

/**
 * An acceptance run is judged by its own verdict on this merge: a `v2:aat verdict=… merge=<sha>`
 * comment from the run's login, posted after it started. Any other comment does not count.
 */
function acceptanceEvidence({ comments, actsAs, engineLogins, mergeSha, sinceMs }) {
  if (!MERGE_SHA.test(String(mergeSha || ''))) {
    return { ok: false, evidence: null, reason: 'acceptance run has no valid merge_sha' };
  }
  const login = String(actsAs || '').toLowerCase();
  const engine = new Set((engineLogins || []).map((name) => String(name).toLowerCase()));
  // The engine's latest launch for this merge: a verdict counts only when it is newer than that launch.
  const launchTimes = (comments || [])
    .filter((entry) => engine.has(String(entry.user?.login || '').toLowerCase()))
    .filter((entry) => new RegExp(`<!--\\s*v2:aat-launch\\s+merge=${mergeSha}\\b`).test(entry.body || ''))
    .map((entry) => Date.parse(entry.created_at))
    .filter(Number.isFinite);
  const latestLaunch = launchTimes.length ? Math.max(...launchTimes) : null;
  const verdict = (comments || []).find((entry) => {
    if (String(entry.user?.login || '').toLowerCase() !== login) return false;
    const postedAt = Date.parse(entry.created_at);
    if (!(postedAt >= sinceMs - SKEW_MS)) return false;
    if (latestLaunch !== null && !(postedAt > latestLaunch)) return false;
    const marker = AAT_VERDICT.exec(entry.body || '');
    const merge = marker && AAT_MERGE.exec(marker[0]);
    return Boolean(merge && merge[1] === mergeSha);
  });
  return verdict
    ? { ok: true, evidence: `verdict ${verdict.id}` }
    : { ok: false, evidence: null, reason: 'no acceptance verdict on this merge newer than its launch' };
}

module.exports = {
  REQUEST_MARKERS,
  SKEW_MS,
  DOORBELL_STAGES,
  MERGE_SHA,
  bodyHasRequestMarker,
  findRequestComment,
  reactionHint,
  runEvidence,
  acceptanceEvidence,
  buildStageTask,
  buildClaudeArgs,
};
