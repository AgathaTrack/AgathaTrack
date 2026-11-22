'use strict';

const { resolveAgent, sharedActsAs } = require('./issue_pipeline_v2_config');
const { listLaunchRecords } = require('./issue_pipeline_v2_launch');

// No signature: the nonce is the run's identity (PIPE-V2-D-REV3-010). A legacy `sig=` is accepted and ignored.
const VERDICT =
  /<!--\s*v2:verdict\s+agent=(\S+)\s+nonce=([a-f0-9]+)\s+kind=(spec|review|edit)\s+hash=(\S+)\s+value=(\S+)(?:\s+sig=[a-f0-9]+)?\s*-->/i;

/** Launch stage each signed kind is allowed under (§3.6). Any other stage's doorbell cannot sign. */
const VERDICT_STAGE = { spec: 'To do', review: 'In analysis', edit: 'In analysis' };

function parseVerdict(body) {
  const match = VERDICT.exec(String(body || ''));
  if (!match) {
    return null;
  }
  return {
    agentId: match[1],
    nonce: match[2],
    kind: match[3],
    hash: match[4],
    value: match[5],
  };
}

function launchForNonce({ comments, engineLogins, agentId, nonce }) {
  return listLaunchRecords({ comments, engineLogins }).find(
    (record) => record.kind === 'launch' && record.agent === agentId && record.nonce === nonce,
  );
}

function verifyVerdictParsed({
  parsed,
  agent,
  comments,
  engineLogins,
  bodyHash,
  timeoutMin,
  postedAt,
  author,
}) {
  const launch = listLaunchRecords({ comments, engineLogins }).find(
    (record) => record.kind === 'launch' && record.agent === agent.id && record.nonce === parsed.nonce,
  );
  if (!launch) {
    return { ok: false, reason: 'unknown-nonce' };
  }
  // Expiry is judged at the time the verdict was posted, not when a later tick reads it (§3.6).
  if (!Number.isFinite(postedAt) || postedAt < launch.at || postedAt - launch.at > timeoutMin * 60 * 1000) {
    return { ok: false, reason: 'expired' };
  }
  if (String(author || '').toLowerCase() !== String(agent.actsAs || '').toLowerCase()) {
    return { ok: false, reason: 'wrong-author' };
  }
  const stage = launch.stage || 'To do';
  if (VERDICT_STAGE[parsed.kind] !== stage) {
    return { ok: false, reason: 'kind-stage-mismatch' };
  }
  if (parsed.hash !== bodyHash) {
    return { ok: false, reason: 'hash-mismatch' };
  }
  return { ok: true, parsed: { ...parsed, agentId: agent.id, actsAs: agent.actsAs } };
}

function useSignedVerdicts(config) {
  return sharedActsAs(config).length > 0;
}

/**
 * Verified agent verdict comments on an issue (newest last). Optional `kinds` and `sinceMs` narrow the scan.
 */
function findVerifiedVerdicts({
  comments,
  config,
  engineLogins,
  issueNumber,
  bodyHash,
  limits,
  kinds,
  sinceMs,
}) {
  if (!bodyHash) {
    return [];
  }
  const timeoutMin = limits?.reviewTimeoutMin || 30;
  const list = [];
  const seen = new Set();
  const ordered = [...(comments || [])].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  for (const comment of ordered) {
    const at = Date.parse(comment.created_at);
    if (sinceMs && at < sinceMs) {
      continue;
    }
    const parsed = parseVerdict(comment.body);
    if (!parsed || (kinds && !kinds.includes(parsed.kind))) {
      continue;
    }
    const agent = resolveAgent(config, parsed.agentId);
    if (!agent) {
      continue;
    }
    const verified = verifyVerdictParsed({
      parsed,
      agent,
      comments,
      engineLogins,
      issueNumber,
      bodyHash,
      timeoutMin,
      postedAt: at,
      author: comment.user?.login,
    });
    if (!verified.ok) {
      continue;
    }
    // Only an id's first verdict of a kind on a hash counts (§3.6).
    const dedupe = `${agent.id}|${parsed.kind}|${parsed.hash}`;
    if (seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    list.push({
      ...parsed,
      agentId: agent.id,
      actsAs: agent.actsAs,
      at,
      commentId: comment.id,
    });
  }
  return list.sort((a, b) => a.at - b.at);
}

module.exports = {
  VERDICT,
  parseVerdict,
  verifyVerdictParsed,
  useSignedVerdicts,
  findVerifiedVerdicts,
};