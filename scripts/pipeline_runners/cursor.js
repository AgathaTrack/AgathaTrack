'use strict';

const { envVarsForCursorLaunch, workerLaunchEnvVars } = require('../../.github/scripts/execute-plan-launch');

const PUBLIC_RUN_ENV = [
  'PIPELINE_AGENT_ID',
  'PIPELINE_STAGE',
  'PIPELINE_RUN_NONCE',
  'PIPELINE_ISSUE',
];

function pipelineRunEnvVars({ issueNumber, agentId, stage, nonce, runSecret, botToken }) {
  const vars = {
    PIPELINE_AGENT_ID: String(agentId),
    PIPELINE_ISSUE: String(issueNumber),
    PIPELINE_RUN_NONCE: String(nonce),
    PIPELINE_RUN_SECRET: String(runSecret),
  };
  if (stage) {
    vars.PIPELINE_STAGE = String(stage);
  }
  const token = botToken || process.env.EXECUTE_PLAN_BOT_TOKEN || process.env.GH_TOKEN;
  const worker = workerLaunchEnvVars(token);
  return envVarsForCursorLaunch({ ...worker, ...vars });
}

/**
 * @returns {Promise<{ runId: string, agentUrl: string|null }>}
 */
async function launch({ agent, issue, owner, repo, stage, method, nonce, runSecret, purpose, apiKey, config, deps = {} }) {
  const launcher = deps.launcher || require('../../.github/scripts/launch-cursor-agent').launchAgent;
  const payloadLib = deps.payload || require('../../.github/scripts/agent-payload-lib');
  const { METHOD_PROMPTS, stagePromptsForConfig } = require('../issue_pipeline_v2_launch');

  const repoUrl = `https://github.com/${owner}/${repo}`;
  const labels = (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
  const payload = payloadLib.buildAgentPayload(
    { number: issue.number, url: issue.html_url, title: issue.title, body: issue.body || '', labels },
    repoUrl,
  );
  const prompts = stagePromptsForConfig(config, agent);
  const extra = stage ? prompts[stage] : METHOD_PROMPTS[method];
  const promptText = [payloadLib.buildAgentPrompt(payload), extra || ''].filter(Boolean).join('\n\n');

  const launched = await launcher({
    apiKey,
    repoUrl,
    promptText,
    model: agent.model || undefined,
    envVars: pipelineRunEnvVars({
      issueNumber: issue.number,
      agentId: agent.id,
      stage: stage || 'In progress',
      nonce,
      runSecret,
    }),
    autoCreatePR: purpose !== 'doorbell',
  });

  const runId = launched.run?.id;
  if (!runId) {
    throw new Error('Cursor API response missing run id');
  }
  return { runId, agentUrl: launched.agent?.url || null };
}

/** Cursor runs are polled via the Agents API elsewhere; doorbell failure uses missing record or timeout. */
async function status() {
  return 'running';
}

module.exports = { launch, status, pipelineRunEnvVars, PUBLIC_RUN_ENV };