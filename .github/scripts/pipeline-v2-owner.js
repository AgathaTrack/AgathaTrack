'use strict';

/**
 * Who writes an issue's `Stage`? (#2385) Once the v2 engine is `on`, it is the only writer for the
 * issues it owns, so the legacy merge / UAT / prod handlers must leave those
 * issues alone: they move the board `Status` after the first merged PR, remove `busy` and reopen,
 * which contradicts the engine's rules (In Main only after the last PR and the Definition of Done).
 *
 * The engine owns an issue when `ISSUE_PIPELINE_V2=on` and either no soak label is configured
 * (`ISSUE_PIPELINE_V2_LABEL` empty: the whole board) or the issue carries that label. In `off` and
 * `dry-run` the legacy writers keep working exactly as before.
 */

function pipelineV2Mode(env = process.env) {
  const mode = String(env.ISSUE_PIPELINE_V2 || 'off').trim().toLowerCase();
  return mode === 'on' || mode === 'dry-run' ? mode : 'off';
}

function pipelineV2ScopeLabel(env = process.env) {
  return String(env.ISSUE_PIPELINE_V2_LABEL || '').trim();
}

/** Label names from a GraphQL issue (`labels.nodes`), a REST issue, or a plain list. */
function labelNames(issueOrLabels) {
  const raw = Array.isArray(issueOrLabels)
    ? issueOrLabels
    : issueOrLabels?.labels?.nodes || issueOrLabels?.labels || [];
  return raw.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
}

/** @param {{ labels?: string[], env?: object }} args */
function v2Owns({ labels = [], env = process.env } = {}) {
  if (pipelineV2Mode(env) !== 'on') {
    return false;
  }
  const scope = pipelineV2ScopeLabel(env);
  return scope === '' || labels.includes(scope);
}

/**
 * Same decision, but labels are only fetched when a scope label makes them matter.
 * @param {{ getLabels: () => Promise<string[]>, env?: object }} args
 */
async function v2OwnsLazy({ getLabels, env = process.env }) {
  if (pipelineV2Mode(env) !== 'on') {
    return false;
  }
  if (pipelineV2ScopeLabel(env) === '') {
    return true;
  }
  return v2Owns({ labels: await getLabels(), env });
}

/**
 * The engine reads one board (Pawpet) of one repository. Other boards (ATSupport) and other
 * repositories' issues are never engine-owned, whatever the soak label says.
 */
function inEngineScope({ boardKey, issueRepoSlug, env = process.env, defaultRepoSlug = '' }) {
  const engineRepo = String(env.GITHUB_REPOSITORY || defaultRepoSlug || '').toLowerCase();
  return boardKey === 'pawpet' && engineRepo !== '' && String(issueRepoSlug || '').toLowerCase() === engineRepo;
}

module.exports = {
  inEngineScope, pipelineV2Mode, pipelineV2ScopeLabel, labelNames, v2Owns, v2OwnsLazy };
