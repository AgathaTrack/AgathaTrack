'use strict';

/**
 * Reads the candidates for the prod guard (#2424): engine-owned issues in In Main / In UAT whose
 * latest merge into main is contained in the promoted SHA, each with its acceptance outcome.
 * Reuses the engine's delivery facts, comment reader and listing helpers. Every network call goes
 * through `deps`, so tests run without GitHub.
 *
 * Token: `readToken` must be read-only. The engine's write-capable ENGINE_PAT must not reach here.
 */

const { rest, listProjectIssues } = require('../../.github/scripts/github-project-lib');
const { listLinkedPrs, deriveDeliveryFacts } = require('../issue_pipeline_v2_release');
const { fetchAllPages } = require('../issue_pipeline_v2_comments');
const { deriveAatFacts, aatSatisfied } = require('./aat_satisfied');
const { GATED_STAGES } = require('./aat_prod_gate');

function entryFieldId(entry) {
  return Number(entry?.field_id ?? entry?.issue_field_id ?? entry?.issue_field?.id);
}

function entryText(entry) {
  const option = entry?.single_select_option || entry?.option;
  if (option?.name) {
    return option.name;
  }
  return typeof entry?.value === 'string' ? entry.value : '';
}

function fieldText(issue, fieldId) {
  const entry = (issue?.issue_field_values || []).find((item) => entryFieldId(item) === fieldId);
  return entryText(entry);
}

function labelNames(issue) {
  return (issue?.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
}

function orgFieldId(defs, name) {
  const key = name.toLowerCase();
  const def = (defs || []).find((item) => String(item?.name || '').toLowerCase() === key);
  return def?.id ? Number(def.id) : null;
}

/** True when `promotedSha` contains `mergeSha` (same test as the engine's deployContains). */
async function promotedContains({ owner, repo, mergeSha, promotedSha, token, restFn }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const compare = await restFn('GET', `${base}/compare/${mergeSha}...${promotedSha}`, token);
  return compare.status === 'ahead' || compare.status === 'identical';
}

/**
 * @returns {Promise<{acceptanceEnabled: boolean, candidates: Array}>}
 * `acceptanceEnabled` is false when the org field `Acceptance` does not exist yet: the feature is
 * off, so nothing can block.
 */
async function collectCandidates({ owner, repo, promotedSha, token, projectId, statusFieldId, scopeLabel = '', config, deps = {} }) {
  const restFn = deps.restFn || rest;
  const listRows = deps.listProjectIssues || listProjectIssues;
  const linkedPrs = deps.listLinkedPrs || listLinkedPrs;
  const pages = deps.fetchAllPages || fetchAllPages;
  const isContained = deps.promotedContains || promotedContains;

  const defs = await restFn('GET', `/orgs/${encodeURIComponent(owner)}/issue-fields`, token);
  const stageId = orgFieldId(defs, 'Stage');
  if (!stageId) {
    throw new Error(`Org issue field "Stage" not found for ${owner}`);
  }
  const acceptanceId = orgFieldId(defs, 'Acceptance');
  if (!acceptanceId) {
    return { acceptanceEnabled: false, candidates: [] };
  }

  const engineLogins = config.engine.logins;
  const listedAgents = config.agents.map((agent) => agent.actsAs);
  const rows = await listRows({ projectId, statusFieldId, projectsPat: token, includeClosed: true });
  const numbers = rows
    .map((row) => row.issue)
    .filter((issue) => issue && issue.repository?.name === repo && issue.repository?.owner?.login === owner)
    .map((issue) => issue.number);

  const candidates = [];
  for (const number of numbers) {
    const issue = await restFn('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, token);
    if (scopeLabel && !labelNames(issue).includes(scopeLabel)) {
      continue;
    }
    const stage = fieldText(issue, stageId);
    if (!GATED_STAGES.has(stage)) {
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
    const acceptance = fieldText(issue, acceptanceId);
    const comments = await pages({
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
      token,
      restFn,
    });
    const aat = deriveAatFacts({ comments, mergeSha, listedAgents, engineLogins });
    const satisfied = aatSatisfied({ acceptance, mergeSha, verdict: aat.verdict, waives: aat.waives });
    candidates.push({ number, stage, mergeSha, inScope, satisfied, acceptance });
  }
  return { acceptanceEnabled: true, candidates };
}

module.exports = { collectCandidates, promotedContains, fieldText, orgFieldId };
