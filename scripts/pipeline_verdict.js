#!/usr/bin/env node
'use strict';

/**
 * Pipeline v2 verdict CLI (#2428, PIPE-V2-D-REV3-010, -011). Reads PIPELINE_AGENT_ID and
 * PIPELINE_RUN_NONCE from the run's environment; the agent never types the nonce.
 *
 *   read                          print `hash=<h>` and the issue body
 *   edit --from <h> --file <p>    replace the body, then post a claim with the run's commit
 *   spec up --hash <h>            post the spec verdict: reveals the nonce (do this last)
 *   review up|down --hash <h>     post the review verdict: reveals the nonce (do this last)
 *
 * One verdict per run: the nonce is revealed once, and only the first reveal counts.
 */

const fs = require('node:fs');
const { bodySha } = require('./issue_pipeline_v2_hash');
const { rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { commitOf } = require('./issue_pipeline_v2_secrets');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function buildClaimComment({ agentId, commit, hash }) {
  return [`<!-- v2:claim agent=${agentId} kind=edit hash=${hash} commit=${commit} -->`, `Edited the body to \`${hash}\`.`].join('\n');
}

function buildVerdictComment({ agentId, nonce, kind, hash, value }) {
  return [
    `<!-- v2:verdict agent=${agentId} nonce=${nonce} kind=${kind} hash=${hash} value=${value} -->`,
    `\`${kind}\` \`${value}\` for hash \`${hash}\`.`,
  ].join('\n');
}

function issueApi(repo, number) {
  const { owner, repo: name } = parseRepo(repo);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${number}`;
  return {
    body: async (token) => (await rest('GET', base, token)).body || '',
    setBody: (token, body) => rest('PATCH', base, token, { body }),
    comment: (token, body) => rest('POST', `${base}/comments`, token, { body }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const [cmd, sub] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const repo = process.env.GITHUB_REPOSITORY;
  const number = Number(process.env.PIPELINE_ISSUE || process.env.ISSUE_NUMBER);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!repo || !number || !token) throw new Error('needs GITHUB_REPOSITORY, PIPELINE_ISSUE and a token');
  const api = issueApi(repo, number);

  if (cmd === 'read') {
    const body = await api.body(token);
    process.stdout.write(`hash=${bodySha(body)}\n\n${body}`);
    return;
  }
  const agentId = requireEnv('PIPELINE_AGENT_ID');
  const nonce = requireEnv('PIPELINE_RUN_NONCE');

  if (cmd === 'edit') {
    const from = flag('from');
    const file = flag('file');
    if (!from || !file) throw new Error('edit requires --from <hash> and --file <path>');
    if (bodySha(await api.body(token)) !== from) throw new Error('body changed since you read it; run read again');
    const next = fs.readFileSync(file, 'utf8');
    if (bodySha(next) === from) throw new Error('the file matches the current body; nothing to edit');
    await api.setBody(token, next);
    const hash = bodySha(await api.body(token));
    if (hash !== bodySha(next)) throw new Error('body changed after the write; no claim posted');
    await api.comment(token, buildClaimComment({ agentId, commit: commitOf(nonce), hash }));
    return;
  }

  const kinds = { spec: ['up'], review: ['up', 'down'] };
  if (!kinds[cmd]?.includes(sub)) throw new Error(`unknown command: ${cmd} ${sub || ''}`.trim());
  const hash = flag('hash');
  if (!hash) throw new Error('--hash is required');
  if (bodySha(await api.body(token)) !== hash) throw new Error('body changed since you read it; run read again');
  await api.comment(token, buildVerdictComment({ agentId, nonce, kind: cmd, hash, value: sub }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { buildVerdictComment, buildClaimComment };
