'use strict';

/**
 * Pipeline v2 run verdicts (PIPE-V2-D-REV3-010, -011). No key, no signature: a run proves who it is
 * by revealing a nonce whose hash the engine committed to when it launched the run.
 *
 *   launch record (engine, at start)   <!-- v2:launch run=<id> agent=<id> purpose=doorbell stage=<s> commit=<sha256(nonce)> -->
 *   claim (run, any time)              <!-- v2:claim agent=<id> kind=edit hash=<h> commit=<sha256(nonce)> -->
 *   verdict (run, last)                <!-- v2:verdict agent=<id> nonce=<nonce> kind=spec|review hash=<h> value=up|down -->
 *
 * The nonce is published only in the run's verdict, so nothing can be copied before the run has
 * voted. Each nonce is revealed once: a second verdict with the same nonce never counts. A claim
 * counts only when the same run's verdict reveals the nonce that matches its commit.
 */

const { resolveAgent } = require('./issue_pipeline_v2_config');
const { listLaunchRecords } = require('./issue_pipeline_v2_launch');
const { commitOf } = require('./issue_pipeline_v2_secrets');

const VERDICT =
  /<!--\s*v2:verdict\s+agent=([\w-]+)\s+nonce=([a-f0-9]+)\s+kind=(spec|review)\s+hash=(\S+)\s+value=(up|down)(?:\s+sig=[a-f0-9]+)?\s*-->/i;
const CLAIM = /<!--\s*v2:claim\s+agent=([\w-]+)\s+kind=(edit)\s+hash=(\S+)\s+commit=([a-f0-9]{64})\s*-->/i;

/** The stage a run must have been launched for to post each kind. */
const KIND_STAGE = { spec: 'To do', review: 'In analysis', edit: 'In analysis' };

function parseVerdict(body) {
  const m = VERDICT.exec(String(body || ''));
  return m ? { agentId: m[1], nonce: m[2].toLowerCase(), kind: m[3], hash: m[4], value: m[5] } : null;
}

function parseClaim(body) {
  const m = CLAIM.exec(String(body || ''));
  return m ? { agentId: m[1], kind: m[2], hash: m[3], commit: m[4].toLowerCase() } : null;
}

/**
 * Doorbell launches by commit. A launch from before REV3-011 carries the plain nonce; its commit is
 * computed here so verdicts from runs already in flight still verify.
 */
function launchesByCommit(comments, engineLogins) {
  const map = new Map();
  for (const record of listLaunchRecords({ comments, engineLogins })) {
    if (record.kind !== 'launch' || !record.agent) continue;
    const commit = record.commit || (record.nonce ? commitOf(record.nonce) : null);
    if (commit) map.set(commit, record);
  }
  return map;
}

/** The launch a post belongs to, when its author, stage and timing fit that launch; otherwise null. */
function launchFor({ launches, commit, agentId, kind, author, at, config, timeoutMs }) {
  const launch = launches.get(commit);
  const agent = resolveAgent(config, agentId);
  if (!launch || !agent || launch.agent !== agent.id) return null;
  if (String(author || '').toLowerCase() !== String(agent.actsAs || '').toLowerCase()) return null;
  if ((launch.stage || 'To do') !== KIND_STAGE[kind]) return null;
  // Judged at the time the post was made, not when a later tick reads it.
  if (!Number.isFinite(at) || at < launch.at || at - launch.at > timeoutMs) return null;
  return { launch, agent };
}

const byTime = (comments) =>
  [...(comments || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

/** Every verified reveal, oldest first: the first verdict per nonce, whatever its hash. */
function verifiedReveals({ comments, config, engineLogins, limits }) {
  const timeoutMs = (limits?.reviewTimeoutMin || 30) * 60 * 1000;
  const launches = launchesByCommit(comments, engineLogins);
  const seen = new Set();
  const out = [];
  for (const comment of byTime(comments)) {
    const parsed = parseVerdict(comment.body);
    if (!parsed) continue;
    const at = Date.parse(comment.created_at);
    const commit = commitOf(parsed.nonce);
    const fit = launchFor({ launches, commit, agentId: parsed.agentId, kind: parsed.kind, author: comment.user?.login, at, config, timeoutMs });
    if (!fit || seen.has(commit)) continue;
    seen.add(commit);
    out.push({ ...parsed, agentId: fit.agent.id, actsAs: fit.agent.actsAs, commit, at, commentId: comment.id });
  }
  return { reveals: out, launches, timeoutMs };
}

/** Verified verdicts on `bodyHash`, oldest first. Optional `kinds` and `sinceMs` narrow the result. */
function findVerifiedVerdicts({ comments, config, engineLogins, bodyHash, limits, kinds, sinceMs }) {
  if (!bodyHash) return [];
  return verifiedReveals({ comments, config, engineLogins, limits }).reveals.filter(
    (v) => v.hash === bodyHash && (!kinds || kinds.includes(v.kind)) && (!sinceMs || v.at >= sinceMs),
  );
}

/**
 * Edit claims confirmed by their run's verdict, oldest first. A claim names a commit; it counts
 * once a verified verdict by the same identity reveals the nonce behind that commit.
 */
function findConfirmedClaims({ comments, config, engineLogins, limits }) {
  const { reveals, launches, timeoutMs } = verifiedReveals({ comments, config, engineLogins, limits });
  const revealedBy = new Map(reveals.map((v) => [v.commit, v.agentId]));
  const out = [];
  for (const comment of byTime(comments)) {
    const claim = parseClaim(comment.body);
    if (!claim) continue;
    const at = Date.parse(comment.created_at);
    const fit = launchFor({ launches, commit: claim.commit, agentId: claim.agentId, kind: claim.kind, author: comment.user?.login, at, config, timeoutMs });
    if (!fit || revealedBy.get(claim.commit) !== fit.agent.id) continue;
    out.push({ ...claim, agentId: fit.agent.id, actsAs: fit.agent.actsAs, at, commentId: comment.id });
  }
  return out;
}

/**
 * Edit claims whose commit matches a doorbell launch of the same identity, in the stage the claim
 * belongs to, and posted within the launch timeout. No nonce is needed: the claim names a commit
 * the engine published at launch, so the claim is the run's own edit even when the run never votes.
 * An edit is the reviewer's approval of the new version and never a verdict (PIPE-V2-D-REV4-002).
 * Oldest first.
 */
function findLaunchVerifiedClaims({ comments, config, engineLogins, limits }) {
  const { launches, timeoutMs } = verifiedReveals({ comments, config, engineLogins, limits });
  const out = [];
  for (const comment of byTime(comments)) {
    const claim = parseClaim(comment.body);
    if (!claim) continue;
    const at = Date.parse(comment.created_at);
    const fit = launchFor({ launches, commit: claim.commit, agentId: claim.agentId, kind: claim.kind, author: comment.user?.login, at, config, timeoutMs });
    if (!fit) continue;
    out.push({ ...claim, agentId: fit.agent.id, actsAs: fit.agent.actsAs, at, commentId: comment.id });
  }
  return out;
}

module.exports = {
  VERDICT,
  CLAIM,
  commitOf,
  parseVerdict,
  parseClaim,
  findVerifiedVerdicts,
  findConfirmedClaims,
  findLaunchVerifiedClaims,
};
