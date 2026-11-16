'use strict';

/**
 * Coded auto-approve policy for issue-pipeline-started execute-plan programmes (D-001).
 * Spec: docs/agent-efficiency/plans/issue-pipeline-automation.md §8
 */

const { bodySha, defaultState } = require('../issue_pipeline_state');
const { findLatestTrustedStateComment } = require('./pipeline_state_trust');
const { evaluatePlannedPathGlobs } = require('./pipeline_path_gate');
const { listActivePlans } = require('./execute_plan_plans');

const PIPELINE_BOTS = new Set(['pawpet-claude', 'pawpet-bot']);

function collectPhasePathPolicy(snapshot) {
  const globs = [];
  const sensitive = new Set();
  for (const phase of snapshot.phases || []) {
    for (const g of phase.allowed_paths || []) globs.push(g);
    for (const g of phase.approved_sensitive_paths || []) sensitive.add(g);
  }
  return { globs, sensitiveGlobs: [...sensitive] };
}

function isSensitiveAllowed(file, sensitiveGlobs) {
  for (const glob of sensitiveGlobs) {
    if (globToRegExp(glob).test(file)) return true;
  }
  return false;
}

/**
 * Expand phase allowed_paths at main; forbidden hits fail unless approved_sensitive_paths covers them.
 * @returns {{ ok: boolean, reason?: string, forbiddenHits?: string[] }}
 */
function evaluatePipelinePlanPaths(snapshot, trackedFiles, { botApprovePath = false } = {}) {
  const { globs, sensitiveGlobs } = collectPhasePathPolicy(snapshot);
  if (!globs.length) return { ok: false, reason: 'no-allowed-paths' };
  if (botApprovePath && sensitiveGlobs.length > 0) {
    return { ok: false, reason: 'bot-sensitive-paths-waived' };
  }
  const gate = evaluatePlannedPathGlobs(globs, trackedFiles);
  if (!gate.ok) {
    const reason = gate.reason === 'sensitive-paths' ? 'forbidden-paths' : gate.reason;
    return { ...gate, reason };
  }
  return gate;
}

/**
 * @param {object|null} commit GitHub commit payload from GET /commits/:sha
 */
function checkInitProvenance(commit, botLogin) {
  if (!commit) return { ok: false, reason: 'no-commit' };
  const author = commit.author && commit.author.login;
  const committer = commit.committer && commit.committer.login;
  if (author !== botLogin && committer !== botLogin) {
    return { ok: false, reason: 'init-not-bot-authored' };
  }
  return { ok: false, reason: 'bot-provenance-suspended' };
}

function checkPipelineLaunchRecord(state) {
  if (!state?.execute_plan_launch?.plan_id) {
    return { ok: false, reason: 'no-pipeline-launch-record' };
  }
  return { ok: true };
}

function checkProductConvergence({ productBody, comments }) {
  const liveSha = bodySha(productBody);
  const latest = findLatestTrustedStateComment(comments);
  if (!latest) return { ok: false, reason: 'no-pipeline-state' };
  const state = { ...defaultState(), ...latest.state };
  if (!state.converged_at) return { ok: false, reason: 'not-converged' };
  if (state.body_sha !== liveSha) return { ok: false, reason: 'body_sha-mismatch' };
  const verdicts = state.verdicts || {};
  if (verdicts['pawpet-claude'] !== 'green' || verdicts['pawpet-bot'] !== 'green') {
    return { ok: false, reason: 'verdicts-not-green' };
  }
  return { ok: true };
}

/**
 * @param {import('./execute_plan_github')} readClient
 * @param {object} opts
 */
async function evaluatePipelineApprovePolicy(readClient, {
  snapshot,
  config,
  initSha,
  killSwitch,
  planId,
  controlIssueNumber,
  botApprovePath = true,
}) {
  if (killSwitch !== 'on') return { ok: false, reason: `driver-${killSwitch}` };
  if (!Number.isInteger(snapshot.source_issue) || snapshot.source_issue < 1) {
    return { ok: false, reason: 'no-source-issue' };
  }
  const sourceN = snapshot.source_issue;

  const treeMap = await readClient.blobShaMapForRef('main');
  if (!treeMap) return { ok: false, reason: 'main-tree-unavailable' };
  const trackedFiles = [...treeMap.keys()];
  const paths = evaluatePipelinePlanPaths(snapshot, trackedFiles, { botApprovePath });
  if (!paths.ok) return paths;

  const product = await readClient.getIssue(sourceN);
  const productComments = await readClient.listIssueComments(sourceN, { pages: 5 });
  const convergence = checkProductConvergence({
    productBody: product.body || '',
    comments: productComments,
  });
  if (!convergence.ok) return convergence;

  const latest = findLatestTrustedStateComment(productComments);
  const launch = checkPipelineLaunchRecord(latest?.state);
  if (!launch.ok) return launch;

  let commit;
  try {
    commit = await readClient.getCommit(initSha);
  } catch {
    return { ok: false, reason: 'init-commit-unavailable' };
  }
  const provenance = checkInitProvenance(commit, config.bot_login);
  if (!provenance.ok) return provenance;

  const active = await listActivePlans(readClient);
  const other = active.filter(
    (p) => p.planId !== planId && p.issueNumber !== controlIssueNumber,
  );
  if (other.length > 0) return { ok: false, reason: 'multiple-active-plans' };

  return { ok: true };
}

module.exports = {
  PIPELINE_BOTS,
  evaluatePipelineApprovePolicy,
  evaluatePipelinePlanPaths,
  checkInitProvenance,
  checkProductConvergence,
  checkPipelineLaunchRecord,
  collectPhasePathPolicy,
};