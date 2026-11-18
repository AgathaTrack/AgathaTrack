'use strict';

const { listLinkedPrs } = require('../issue_pipeline_v2_release');
const { lastMainMergeShaFromLinkedPrs, validateMergeSha } = require('./github_issue_workflow_aat');
const { resolveToken } = require('./execute_plan_github');

function resolveGhToken(env = process.env) {
  return resolveToken(null, env);
}

/**
 * @param {{ issueNumber: number, owner: string, repo: string, merge?: string, token?: string|null, listLinkedPrs?: typeof listLinkedPrs }} opts
 */
async function resolveAatMergeSha(opts) {
  if (opts.merge) {
    return validateMergeSha(opts.merge);
  }
  const token = Object.prototype.hasOwnProperty.call(opts, 'token')
    ? opts.token
    : resolveGhToken();
  if (!token) {
    throw new Error(
      'merge SHA required (--merge) or set GH_TOKEN / PAWPET_CLAUDE_TOKEN to resolve from linked PRs',
    );
  }
  const listFn = opts.listLinkedPrs || listLinkedPrs;
  const prs = await listFn({
    owner: opts.owner,
    repo: opts.repo,
    issueNumber: opts.issueNumber,
    token,
  });
  return lastMainMergeShaFromLinkedPrs(prs);
}

module.exports = { resolveAatMergeSha, resolveGhToken };