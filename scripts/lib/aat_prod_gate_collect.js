'use strict';

/**
 * Reads the candidates for the prod guard (#2424). The rules are the engine's (#2448), not a copy:
 * `aatGateOn`, `deriveAatState`, `aatSatisfied` and `newestActionable` come from
 * scripts/issue_pipeline_v2_acceptance.js, so the In Main gate and the prod guard cannot disagree.
 *
 * A candidate is an engine-owned merge that is contained in the promoted SHA and not yet
 * satisfied. It is gated when its issue is In Main or In UAT, or when it is In progress because the
 * newest actionable verdict for that merge is a scope or implementation fail (#2448 rewind rows).
 * Follow-ups and `manual-only` issues are exempt, as in the engine.
 *
 * Every network call goes through `deps`, so tests run without GitHub.
 * Token: `token` must be read-only. The engine's write-capable ENGINE_PAT must not reach here.
 */

const { rest, listProjectIssues } = require('../../.github/scripts/github-project-lib');
const { listLinkedPrs, deriveDeliveryFacts } = require('../issue_pipeline_v2_release');
const { fetchAllPages } = require('../issue_pipeline_v2_comments');
const { loadOrgFields, parseIssueFields } = require('../issue_pipeline_v2_fields');
const { agentLogins } = require('../issue_pipeline_v2_config');
const {
  aatGateOn,
  aatSatisfied,
  deriveAatState,
  newestActionable,
} = require('../issue_pipeline_v2_acceptance');
const { parseFollowUp } = require('../issue_pipeline_v2_intent');
const { canonicalStage } = require('../issue_pipeline_v2_decide');

const GATED_STAGES = new Set(['In Main', 'In UAT']);
const REWIND_REASONS = new Set(['scope', 'implementation']);

function labelNames(issue) {
  return (issue?.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
}

/** True when `promotedSha` contains `mergeSha` (same test as the engine's deployContains). */
async function promotedContains({ owner, repo, mergeSha, promotedSha, token, restFn }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const compare = await restFn('GET', `${base}/compare/${mergeSha}...${promotedSha}`, token);
  return compare.status === 'ahead' || compare.status === 'identical';
}

function isGated(stage, newest) {
  if (GATED_STAGES.has(stage)) {
    return true;
  }
  return stage === 'In progress' && newest?.verdict === 'fail' && REWIND_REASONS.has(newest.reason);
}

/**
 * @returns {Promise<{gateEnabled: boolean, candidates: Array}>}
 * `gateEnabled` is false when `aat.enabled` is false or either acceptance org field is missing. In
 * that case nothing is read beyond the field definitions and nothing can block.
 */
async function collectCandidates({ owner, repo, promotedSha, token, projectId, statusFieldId, scopeLabel = '', config, deps = {} }) {
  if (!config.aat?.enabled) {
    return { gateEnabled: false, candidates: [] };
  }
  const restFn = deps.restFn || rest;
  const listRows = deps.listProjectIssues || listProjectIssues;
  const linkedPrs = deps.listLinkedPrs || listLinkedPrs;
  const pages = deps.fetchAllPages || fetchAllPages;
  const isContained = deps.promotedContains || promotedContains;

  const fields = await (deps.loadOrgFields || loadOrgFields)({ org: owner, token, restFn });
  const aatFieldsPresent = Boolean(fields.acceptance && fields.acceptanceFailReason);
  if (!aatFieldsPresent) {
    return { gateEnabled: false, candidates: [] };
  }

  const engineLogins = config.engine.logins;
  const listedAgents = agentLogins(config);
  const rows = await listRows({
    projectId,
    statusFieldId,
    projectsPat: token,
    includeClosed: true,
    owner,
    repo,
  });
  const numbers = rows.map((row) => row.issue).filter(Boolean).map((issue) => issue.number);

  const candidates = [];
  for (const number of numbers) {
    const issue = await restFn('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, token);
    const labels = labelNames(issue);
    if ((scopeLabel && !labels.includes(scopeLabel)) || labels.includes('manual-only')) {
      continue;
    }
    const isFollowUp = Boolean(parseFollowUp(issue.body));
    if (!aatGateOn({ aatFieldsPresent, isFollowUp }, config)) {
      continue;
    }
    const parsed = parseIssueFields(issue, fields);
    const stage = canonicalStage(parsed.stage);
    if (stage !== 'In progress' && !GATED_STAGES.has(stage)) {
      continue;
    }
    const prs = await linkedPrs({ owner, repo, issueNumber: number, token });
    const mergeSha = deriveDeliveryFacts({ issue, prs, comments: [], engineLogins }).delivery?.lastMergeSha || null;
    if (!mergeSha) {
      continue;
    }
    const inScope = await isContained({ owner, repo, mergeSha, promotedSha, token, restFn });
    if (!inScope) {
      continue;
    }
    const comments = await pages({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      token,
      restFn,
    });
    const state = deriveAatState({ comments, engineLogins, agentLogins: listedAgents });
    const acceptance = parsed.acceptance || '';
    const facts = { aat: state, acceptance };
    const newest = newestActionable(state, mergeSha);
    if (!isGated(stage, newest)) {
      continue;
    }
    candidates.push({
      number,
      stage,
      mergeSha,
      acceptance,
      satisfied: aatSatisfied(facts, mergeSha),
    });
  }
  return { gateEnabled: true, candidates };
}

module.exports = { collectCandidates, promotedContains, isGated };
