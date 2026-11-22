#!/usr/bin/env node
'use strict';

/**
 * Last step of pipeline-claude-run.yml: fail the job when the Claude run left no comment and no
 * reaction on the issue since it started. A failed job is `status() === 'failed'` in
 * `scripts/pipeline_runners/claude.js`, so the next live tick reassigns the pickup instead of
 * waiting out the timeout behind `busy` (soak-6, #2485). Reads only; prints no secret.
 */

const { parseRepo } = require('../.github/scripts/github-project-lib');
const { loadConfig, resolveAgent, isSharedActsAs } = require('./issue_pipeline_v2_config');
const { listIssueComments, listCommentReactions } = require('./issue_pipeline_v2_comments');
const { findRequestComment, runEvidence } = require('./pipeline_claude_run_lib');

async function verify({ owner, repo, issueNumber, stage, agentId, nonce, sinceMs, token, deps = {} }) {
  const config = deps.config || loadConfig();
  const agent = resolveAgent(config, agentId);
  if (!agent) {
    throw new Error(`unknown agent ${agentId}`);
  }
  const listComments = deps.listIssueComments || listIssueComments;
  const listReactions = deps.listCommentReactions || listCommentReactions;
  const comments = await listComments({ owner, repo, issueNumber, token });
  const request = findRequestComment({ comments, stage, engineLogins: config.engine.logins });
  const shared = isSharedActsAs(config, agent.actsAs);
  // A shared login's reactions cannot name the run, so they are not read at all.
  const reactions = request && !shared ? await listReactions({ owner, repo, commentId: request.id, token }) : [];
  return runEvidence({ comments, reactions, actsAs: agent.actsAs, agentId, nonce, shared, sinceMs });
}

async function main() {
  const { owner, repo } = parseRepo(process.env.GITHUB_REPOSITORY || '');
  const issueNumber = Number(process.env.PIPELINE_ISSUE);
  const sinceMs = Date.parse(process.env.PIPELINE_RUN_STARTED_AT || '');
  const token = process.env.GH_TOKEN;
  if (!issueNumber || !Number.isFinite(sinceMs) || !token) {
    throw new Error('missing PIPELINE_ISSUE, PIPELINE_RUN_STARTED_AT or GH_TOKEN');
  }
  const result = await verify({
    owner,
    repo,
    issueNumber,
    stage: process.env.PIPELINE_STAGE,
    agentId: process.env.PIPELINE_AGENT_ID,
    nonce: process.env.PIPELINE_RUN_NONCE,
    sinceMs,
    token,
  });
  if (!result.ok) {
    console.error(
      `::error::The Claude run left no trace on #${issueNumber}${result.reason ? ` (${result.reason})` : ''}. Failing the job so the engine reassigns the pickup.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Claude run evidence on #${issueNumber}: ${result.evidence}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}

module.exports = { verify };
