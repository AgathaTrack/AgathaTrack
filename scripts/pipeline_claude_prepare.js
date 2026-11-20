#!/usr/bin/env node
'use strict';

/**
 * First step of pipeline-claude-run.yml: derive run secret, export PIPELINE_* env, build prompt.
 */

const fs = require('fs');
const { parseRepo } = require('../.github/scripts/github-project-lib');
const { loadConfig, resolveAgent } = require('./issue_pipeline_v2_config');
const { deriveRunSecret } = require('./issue_pipeline_v2_secrets');
const { METHOD_PROMPTS, STAGE_PROMPTS, stagePromptsForConfig } = require('./issue_pipeline_v2_launch');
const { listIssueComments } = require('./issue_pipeline_v2_comments');
const { findRequestComment, reactionHint } = require('./pipeline_claude_run_lib');

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
  console.log(`::add-mask::${runSecret}`);
  appendEnv('PIPELINE_RUN_SECRET', runSecret);
  appendEnv('PIPELINE_AGENT_ID', agentId);
  appendEnv('PIPELINE_RUN_NONCE', nonce);
  appendEnv('PIPELINE_ISSUE', String(issueNumber));
  appendEnv('PIPELINE_STAGE', stage);
  // The verify step counts only what the run posts after this instant.
  appendEnv('PIPELINE_RUN_STARTED_AT', new Date().toISOString());

  const prompts = stagePromptsForConfig(config, agent);
  const extra = stage ? prompts[stage] : METHOD_PROMPTS[method];
  // Reaction path only (a login with one pool id): name the comment and the exact command, so the
  // vote does not depend on the run finding the comment id itself (soak-6, #2485).
  let hint = '';
  if (stage && prompts === STAGE_PROMPTS) {
    try {
      const comments = await listIssueComments({ owner, repo, issueNumber, token });
      const request = findRequestComment({ comments, stage, engineLogins: config.engine.logins });
      hint = reactionHint({ owner, repo, stage, commentId: request?.id });
    } catch (error) {
      console.log(`::warning::could not read the request comment: ${error?.message || error}`);
    }
  }
  const prompt = [
    `You are pipeline agent \`${agentId}\` (\`@${agent.actsAs}\`).`,
    `Repository: ${owner}/${repo}. Issue #${issueNumber}.`,
    extra || '',
    hint,
    'Follow AGENTS.md and CLAUDE.md in this repository.',
    `Issue URL: https://github.com/${owner}/${repo}/issues/${issueNumber}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  setOutput('prompt', prompt);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});