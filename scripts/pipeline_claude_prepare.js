#!/usr/bin/env node
'use strict';

/**
 * First step of pipeline-claude-run.yml: derive run secret, export PIPELINE_* env, build prompt.
 */

const fs = require('fs');
const { rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { loadConfig, resolveAgent } = require('./issue_pipeline_v2_config');
const { deriveRunSecret } = require('./issue_pipeline_v2_secrets');
const { METHOD_PROMPTS, stagePromptsForConfig } = require('./issue_pipeline_v2_launch');

function appendEnv(name, value) {
  const path = process.env.GITHUB_ENV;
  if (!path) {
    return;
  }
  const escaped = String(value).replace(/\n/g, '%0A');
  fs.appendFileSync(path, `${name}=${escaped}\n`);
}

function setOutput(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) {
    return;
  }
  const delimiter = `EOF_${name}_${Date.now()}`;
  fs.appendFileSync(path, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

async function main() {
  const issueNumber = Number(process.env.INPUT_ISSUE);
  const stage = process.env.INPUT_STAGE;
  const agentId = process.env.INPUT_AGENT_ID;
  const method = process.env.INPUT_METHOD || 'PR';
  const nonce = process.env.INPUT_NONCE;
  const voteKey = process.env.PIPELINE_VOTE_KEY;
  const token = process.env.GH_TOKEN;
  if (!voteKey || !token || !nonce || !agentId || !issueNumber) {
    throw new Error('missing required pipeline claude prepare inputs');
  }
  const { owner, repo } = parseRepo(process.env.GITHUB_REPOSITORY || '');
  const config = loadConfig();
  const agent = resolveAgent(config, agentId);
  if (!agent) {
    throw new Error(`unknown agent ${agentId}`);
  }
  const runSecret = deriveRunSecret(voteKey, issueNumber, agentId, stage, nonce);
  appendEnv('PIPELINE_RUN_SECRET', runSecret);
  appendEnv('PIPELINE_AGENT_ID', agentId);
  appendEnv('PIPELINE_RUN_NONCE', nonce);
  appendEnv('PIPELINE_ISSUE', String(issueNumber));
  appendEnv('PIPELINE_STAGE', stage);

  const issue = await rest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`, token);
  const prompts = stagePromptsForConfig(config, agent);
  const extra = stage ? prompts[stage] : METHOD_PROMPTS[method];
  const prompt = [
    `You are pipeline agent \`${agentId}\` (\`@${agent.actsAs}\`).`,
    `Repository: ${owner}/${repo}. Issue #${issueNumber}.`,
    extra || '',
    'Follow AGENTS.md and CLAUDE.md in this repository.',
    `Issue URL: https://github.com/${owner}/${repo}/issues/${issueNumber}`,
    issue.title ? `Title: ${issue.title}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  setOutput('prompt', prompt);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});