#!/usr/bin/env node
'use strict';

/**
 * Pipeline v2 signed verdict CLI (#2428). Uses PIPELINE_RUN_SECRET and public PIPELINE_* env only.
 */

const fs = require('node:fs');
const { bodySha } = require('./issue_pipeline_v2_hash');
const { verdictSignature } = require('./issue_pipeline_v2_secrets');
const { rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { resolveAgent, loadConfig } = require('./issue_pipeline_v2_config');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--hash' && argv[i + 1]) {
      flags.hash = argv[++i];
    } else if (argv[i] === '--from' && argv[i + 1]) {
      flags.from = argv[++i];
    } else if (argv[i] === '--file' && argv[i + 1]) {
      flags.file = argv[++i];
    } else if (!argv[i].startsWith('-')) {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

async function fetchIssueBody({ owner, repo, number, token }) {
  const issue = await rest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`, token);
  return issue.body || '';
}

async function cmdRead({ repo, number, token }) {
  const { owner, repo: name } = parseRepo(repo);
  const body = await fetchIssueBody({ owner, repo: name, number, token });
  const hash = bodySha(body);
  process.stdout.write(`hash=${hash}\n\n${body}`);
}

function buildVerdictComment({ agentId, nonce, kind, hash, value, sig }) {
  return [
    `<!-- v2:verdict agent=${agentId} nonce=${nonce} kind=${kind} hash=${hash} value=${value} sig=${sig} -->`,
    `Signed \`${kind}\` \`${value}\` for hash \`${hash}\`.`,
  ].join('\n');
}

async function cmdEdit({ flags, repo, number, token }) {
  const fromHash = flags.from;
  const file = flags.file;
  if (!fromHash || !file) {
    throw new Error('edit requires --from <hash> and --file <path>');
  }
  const { owner, repo: name } = parseRepo(repo);
  const body = await fetchIssueBody({ owner, repo: name, number, token });
  if (bodySha(body) !== fromHash) {
    throw new Error('body hash mismatch; run read again');
  }
  const next = fs.readFileSync(file, 'utf8');
  if (bodySha(next) === fromHash) {
    throw new Error('file body matches current hash; nothing to edit');
  }
  await rest('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`, token, {
    body: next,
  });
  const newBody = await fetchIssueBody({ owner, repo: name, number, token });
  const newHash = bodySha(newBody);
  const agentId = requireEnv('PIPELINE_AGENT_ID');
  const nonce = requireEnv('PIPELINE_RUN_NONCE');
  const runSecret = requireEnv('PIPELINE_RUN_SECRET');
  const sig = verdictSignature(runSecret, number, agentId, nonce, 'edit', newHash, 'up');
  const comment = buildVerdictComment({ agentId, nonce, kind: 'edit', hash: newHash, value: 'up', sig });
  await rest('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`, token, {
    body: comment,
  });
}

async function cmdSign({ kind, value, flags, repo, number, token }) {
  const agentId = requireEnv('PIPELINE_AGENT_ID');
  const nonce = requireEnv('PIPELINE_RUN_NONCE');
  const runSecret = requireEnv('PIPELINE_RUN_SECRET');
  const hash = flags.hash;
  if (!hash) {
    throw new Error('--hash is required');
  }
  const { owner, repo: name } = parseRepo(repo);
  const body = await fetchIssueBody({ owner, repo: name, number, token });
  if (bodySha(body) !== hash) {
    throw new Error('body changed since you read it; run read again');
  }
  const config = loadConfig();
  const agent = resolveAgent(config, agentId);
  if (!agent) {
    throw new Error(`unknown agent ${agentId}`);
  }
  const sig = verdictSignature(runSecret, number, agentId, nonce, kind, hash, value);
  const comment = buildVerdictComment({ agentId, nonce, kind, hash, value, sig });
  await rest('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}/comments`, token, {
    body: comment,
  });
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, repoArg, issueArg] = positional;
  const repo = repoArg || process.env.GITHUB_REPOSITORY;
  const number = Number(issueArg || process.env.PIPELINE_ISSUE || process.env.ISSUE_NUMBER);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!repo || !number || !token) {
    throw new Error('usage: pipeline_verdict.js read <owner/repo> <n> | spec|review up|down --hash <h>');
  }
  if (cmd === 'read') {
    await cmdRead({ repo, number, token });
    return;
  }
  if (cmd === 'edit') {
    await cmdEdit({ flags, repo, number, token });
    return;
  }
  if (cmd === 'spec' && sub === 'up') {
    await cmdSign({ kind: 'spec', value: 'up', flags, repo, number, token });
    return;
  }
  if (cmd === 'review' && (sub === 'up' || sub === 'down')) {
    await cmdSign({ kind: 'review', value: sub, flags, repo, number, token });
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { buildVerdictComment };