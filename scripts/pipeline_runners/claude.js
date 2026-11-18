'use strict';

const { rest } = require('../../.github/scripts/github-project-lib');

const WORKFLOW_FILE = 'pipeline-claude-run.yml';

function enc(owner, repo, path) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

/**
 * @returns {Promise<{ runId: string, agentUrl: null }>}
 */
async function launch({ agent, issue, owner, repo, stage, method, nonce, config, deps = {} }) {
  if (!nonce) {
    throw new Error('claude launch requires nonce');
  }
  const token = deps.dispatchToken || process.env.GH_PROJECTS_PAT;
  const restFn = deps.restFn || rest;
  const active = await countActiveClaudeRuns({ owner, repo, deps });
  const cap = config?.limits?.runnerWip?.claude || 1;
  if (active >= cap) {
    throw new Error(`claude runner at WIP cap (${active}/${cap})`);
  }
  await restFn('POST', enc(owner, repo, `/actions/workflows/${WORKFLOW_FILE}/dispatches`), token, {
    ref: 'main',
    inputs: {
      issue: String(issue.number),
      stage: stage || 'In progress',
      agent_id: agent.id,
      method: method || 'PR',
      nonce,
    },
  });
  return { runId: `claude:${nonce}`, agentUrl: null };
}

async function listWorkflowRuns({ owner, repo, deps }) {
  const token = deps.dispatchToken || process.env.GH_PROJECTS_PAT;
  const restFn = deps.restFn || rest;
  const payload = await restFn('GET', enc(owner, repo, `/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`), token);
  return payload?.workflow_runs || [];
}

async function countActiveClaudeRuns({ owner, repo, deps }) {
  const runs = await listWorkflowRuns({ owner, repo, deps });
  return runs.filter((run) => run.status === 'in_progress' || run.status === 'queued' || run.status === 'waiting').length;
}

/**
 * @returns {'running' | 'finished' | 'failed'}
 */
async function status({ nonce, owner, repo, deps = {} }) {
  if (!nonce) {
    return 'running';
  }
  const runs = await listWorkflowRuns({ owner, repo, deps });
  const expectedName = `pipeline-claude-${nonce}`;
  const hit =
    runs.find((run) => run.name === expectedName) ||
    runs.find((run) => String(run.display_title || '').includes(nonce));
  if (!hit) {
    return 'running';
  }
  if (hit.status !== 'completed') {
    return 'running';
  }
  if (hit.conclusion === 'success') {
    return 'finished';
  }
  if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(hit.conclusion)) {
    return 'failed';
  }
  return 'running';
}

module.exports = { launch, status, countActiveClaudeRuns, WORKFLOW_FILE };