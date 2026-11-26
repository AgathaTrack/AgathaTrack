'use strict';

const { randomBytes } = require('node:crypto');
const { rest } = require('../../.github/scripts/github-project-lib');

const WORKFLOW_FILE = 'pipeline-claude-run.yml';

/** In-tick dispatches reserved before Actions lists them (reset in tests via resetLocalReservationsForTests). */
let localReservations = 0;

function resetLocalReservationsForTests() {
  localReservations = 0;
}

function runnerQueuedError(active, cap) {
  const error = new Error(`claude runner at WIP cap (${active}/${cap})`);
  error.code = 'RUNNER_QUEUED';
  return error;
}

function enc(owner, repo, path) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${path}`;
}

/**
 * @returns {Promise<{ runId: string, agentUrl: null }>}
 */
async function launch({ agent, issue, owner, repo, stage, method, nonce, purpose, config, mergeSha, deps = {} }) {
  if (!nonce) {
    throw new Error('claude launch requires nonce');
  }
  const token = deps.dispatchToken || process.env.GH_PROJECTS_PAT;
  const restFn = deps.restFn || rest;
  const runRef = (deps.randomRef || (() => randomBytes(8).toString('hex')))();
  const active = await countActiveClaudeRuns({ owner, repo, deps });
  const cap = config?.limits?.runnerWip?.claude ?? 3;
  if (active + localReservations >= cap) {
    throw runnerQueuedError(active + localReservations, cap);
  }
  localReservations += 1;
  const doorbellStage =
    purpose === 'delivery' ? 'In progress' : purpose === 'babysit' ? 'babysit' : stage || 'In progress';
  try {
    await restFn('POST', enc(owner, repo, `/actions/workflows/${WORKFLOW_FILE}/dispatches`), token, {
      ref: 'main',
      inputs: {
        issue: String(issue.number),
        stage: doorbellStage,
        agent_id: agent.id,
        method: method || 'PR',
        nonce,
        // The run name and the run id use this public reference, never the nonce (PIPE-V2-D-REV3-011).
        run_ref: runRef,
        // Acceptance runs judge one merge, so the run is told which one. Other runs send no merge.
        ...(mergeSha ? { merge_sha: String(mergeSha) } : {}),
      },
    });
  } catch (error) {
    localReservations -= 1;
    throw error;
  }
  return { runId: `claude:${runRef}`, agentUrl: null };
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
async function status({ runId, owner, repo, deps = {} }) {
  const runRef = String(runId || '').startsWith('claude:') ? String(runId).slice('claude:'.length) : '';
  if (!runRef) {
    return 'running';
  }
  const runs = await listWorkflowRuns({ owner, repo, deps });
  const expectedName = `pipeline-claude-${runRef}`;
  const hit = runs.find((run) => run.name === expectedName || run.display_title === expectedName);
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

function isRunnerQueuedError(error) {
  return error?.code === 'RUNNER_QUEUED';
}

module.exports = {
  launch,
  status,
  countActiveClaudeRuns,
  isRunnerQueuedError,
  resetLocalReservationsForTests,
  WORKFLOW_FILE,
};