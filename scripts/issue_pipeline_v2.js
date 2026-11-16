#!/usr/bin/env node
'use strict';

/**
 * Pipeline v2 runner (#2385, run A). Reads the Pawpet board, builds facts per issue, calls
 * `decide()` and logs the action. Field writes are disabled until run B: this tick never writes.
 */

const { listProjectIssues, rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { resolvePipelineMode } = require('./issue_pipeline_mode');
const { bodySha } = require('./issue_pipeline_state');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide, canonicalStage } = require('./issue_pipeline_v2_decide');
const { loadOrgFields, parseIssueFields, writeIssueFields } = require('./issue_pipeline_v2_fields');
const {
  deriveSpecFacts,
  humanCommentSinceBlock,
  listIssueComments,
  listCommentReactions,
} = require('./issue_pipeline_v2_comments');

/** Flipped on in run B, together with the launch and release stages. */
const WRITES_ENABLED = false;

function mode() {
  return resolvePipelineMode(process.env.ISSUE_PIPELINE_V2);
}

/** Facts available from the issue itself; later phases add comments, reactions and PRs. */
function buildBaseFacts({ issue, parsed, onBoard, wip, now, runMode }) {
  return {
    mode: runMode,
    now,
    onBoard,
    labels: (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)),
    stage: parsed.stage,
    blocked: parsed.blocked,
    bodyHash: bodySha(issue.body),
    wip,
  };
}

/**
 * Facts that need comments or reactions. Only read for the stages that use them, so a board of
 * mostly Backlog and Done issues costs no extra calls.
 */
async function buildCommentFacts({ owner, repo, entry, config, token, io }) {
  const canonical = canonicalStage(entry.parsed.stage);
  const needsComments = canonical === 'To do' || Boolean(entry.parsed.blocked);
  if (!needsComments) {
    return {};
  }
  const comments = await (io.listIssueComments || listIssueComments)({
    owner,
    repo,
    issueNumber: entry.number,
    token,
  });
  const facts = {};
  if (entry.parsed.blocked) {
    facts.humanCommentSinceBlock = humanCommentSinceBlock(comments, config);
  }
  if (canonical === 'To do' && !entry.parsed.blocked) {
    const probe = deriveSpecFacts({ comments, reactions: [], config, engineLogins: config.engine.logins });
    const reactions = probe.commentId
      ? await (io.listCommentReactions || listCommentReactions)({
          owner,
          repo,
          commentId: probe.commentId,
          token,
        })
      : [];
    facts.spec = deriveSpecFacts({ comments, reactions, config, engineLogins: config.engine.logins });
  }
  return facts;
}

function countWip(entries) {
  return entries.filter(
    (entry) =>
      canonicalStage(entry.stage) === 'In progress' && !entry.labels.includes('manual-only'),
  ).length;
}

async function tick({ owner, repo, token, projectsPat, projectId, statusFieldId, only, io = {} }) {
  const runMode = mode();
  if (runMode === 'off') {
    return { mode: runMode, skipped: true, reason: 'ISSUE_PIPELINE_V2 off', actions: [] };
  }
  const config = io.config || loadConfig();
  const list = io.listProjectIssues || listProjectIssues;
  const getIssue =
    io.getIssue ||
    ((number) => rest('GET', `/repos/${owner}/${repo}/issues/${number}`, projectsPat));
  const fields = io.fields || (await loadOrgFields({ org: owner, token: projectsPat }));

  const rows = await list({ projectId, statusFieldId, projectsPat });
  const numbers = rows
    .map((row) => row.issue)
    .filter((issue) => issue && issue.state === 'OPEN' && issue.repository?.name === repo)
    .map((issue) => issue.number);

  const entries = [];
  for (const number of numbers) {
    const issue = await getIssue(number);
    const parsed = parseIssueFields(issue, fields);
    entries.push({
      number,
      issue,
      parsed,
      stage: parsed.stage,
      labels: (issue.labels || []).map((label) => label.name || label),
    });
  }
  const wip = countWip(entries);
  const now = Date.now();
  const actions = [];
  for (const entry of entries) {
    if (only && entry.number !== only) {
      continue;
    }
    const facts = {
      ...buildBaseFacts({
        issue: entry.issue,
        parsed: entry.parsed,
        onBoard: true,
        wip,
        now,
        runMode,
      }),
      ...(await buildCommentFacts({ owner, repo, entry, config, token: projectsPat, io })),
    };
    const action = decide(facts, config);
    actions.push({ issue: entry.number, stage: entry.parsed.stage || 'Backlog', action });
    console.log(
      JSON.stringify({ event: 'pipeline_v2_action', mode: runMode, writes: WRITES_ENABLED, issue: entry.number, action }),
    );
    if (action.type === 'set-stage' || action.type === 'set-blocked') {
      const writes =
        action.type === 'set-stage'
          ? { stage: action.to, attempts: 0 }
          : { blocked: action.reason };
      await writeIssueFields({
        owner,
        repo,
        issueNumber: entry.number,
        token: projectsPat,
        fields,
        writes,
        dryRun: !(WRITES_ENABLED && runMode === 'on'),
      });
    }
  }
  return { mode: runMode, issueCount: entries.length, wip, actions };
}

async function main() {
  const { owner, repo } = parseRepo(process.env.GITHUB_REPOSITORY || '');
  const projectsPat = process.env.GH_PROJECTS_PAT;
  const projectId = process.env.GH_PROJECT_ID;
  const statusFieldId = process.env.GH_STATUS_FIELD_ID;
  if (mode() !== 'off' && (!projectsPat || !projectId || !statusFieldId)) {
    throw new Error('GH_PROJECTS_PAT, GH_PROJECT_ID and GH_STATUS_FIELD_ID are required');
  }
  const only = process.env.ISSUE_NUMBER ? Number(process.env.ISSUE_NUMBER) : null;
  const result = await tick({
    owner,
    repo,
    token: process.env.GITHUB_TOKEN,
    projectsPat,
    projectId,
    statusFieldId,
    only,
  });
  console.log(JSON.stringify({ event: 'pipeline_v2_tick', ...result, actions: result.actions?.length }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { tick, buildBaseFacts, buildCommentFacts, countWip, WRITES_ENABLED };
