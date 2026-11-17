#!/usr/bin/env node
'use strict';

/**
 * Pipeline v2 runner (#2385, run A). Reads the Pawpet board, builds facts per issue, calls
 * `decide()` and logs the action. Writes happen only in `on` mode with a token that is the configured engine identity.
 */

const { listProjectIssues, rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { resolvePipelineMode } = require('./issue_pipeline_mode');
const { bodySha } = require('./issue_pipeline_state');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { decide, canonicalStage } = require('./issue_pipeline_v2_decide');
const { loadOrgFields, parseIssueFields } = require('./issue_pipeline_v2_fields');
const { applyAction, buildWrites } = require('./issue_pipeline_v2_apply');
const { checkEngineIdentity, writesAllowed } = require('./issue_pipeline_v2_identity');
const {
  deriveSpecFacts,
  latestHumanComment,
  wokenCommentIds,
  listIssueComments,
  listCommentReactions,
} = require('./issue_pipeline_v2_comments');
const { deriveReviewFacts, findReviewRequests, totalNWrite } = require('./issue_pipeline_v2_review');
const { fetchBodyEdits, fetchCommentEditor } = require('./issue_pipeline_v2_graphql');

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

/** Last editors of edited engine-authored comments (GraphQL), keyed by comment node id. */
async function resolveEditors({ comments, config, token, io }) {
  const editors = {};
  for (const comment of comments) {
    const edited = comment.updated_at && comment.updated_at !== comment.created_at;
    const byEngine = config.engine.logins.includes(comment.user?.login);
    if (edited && byEngine && /<!--\s*v2:(spec|review)-request/.test(comment.body || '')) {
      editors[comment.node_id] = await (io.fetchCommentEditor || fetchCommentEditor)({
        nodeId: comment.node_id,
        token,
      });
    }
  }
  return editors;
}

/**
 * Facts that need comments, reactions or edit history. Only read for the stages that use them,
 * so a board of mostly Backlog and Done issues costs no extra calls.
 */
async function buildCommentFacts({ owner, repo, entry, config, token, io }) {
  const canonical = canonicalStage(entry.parsed.stage);
  const blocked = Boolean(entry.parsed.blocked);
  if (!(canonical === 'To do' || canonical === 'In analysis' || blocked)) {
    return {};
  }
  const comments = await (io.listIssueComments || listIssueComments)({
    owner,
    repo,
    issueNumber: entry.number,
    token,
  });
  const facts = {};
  if (blocked) {
    const human = latestHumanComment(comments, config);
    facts.humanCommentSinceBlock = Boolean(human);
    facts.humanCommentId = human ? human.id : null;
    facts.wokenFor = wokenCommentIds(comments, config.engine.logins);
    return facts;
  }
  const editors = await resolveEditors({ comments, config, token, io });
  const engineLogins = config.engine.logins;
  const reactionsOf = (commentId) =>
    (io.listCommentReactions || listCommentReactions)({ owner, repo, commentId, token });

  if (canonical === 'To do') {
    const probe = deriveSpecFacts({ comments, reactions: [], config, engineLogins, editors });
    const reactions = probe.commentId ? await reactionsOf(probe.commentId) : [];
    facts.spec = deriveSpecFacts({ comments, reactions, config, engineLogins, editors });
    return facts;
  }

  const requests = findReviewRequests(comments, engineLogins, editors);
  const reactionsByComment = {};
  for (const request of requests) {
    reactionsByComment[request.comment.id] = await reactionsOf(request.comment.id);
  }
  const history = await (io.fetchBodyEdits || fetchBodyEdits)({
    owner,
    repo,
    issueNumber: entry.number,
    token: io.graphqlToken || token,
  });
  const derived = deriveReviewFacts({
    comments,
    reactionsByComment,
    edits: history.edits,
    bodyAuthor: history.author,
    config,
    engineLogins,
    editors,
  });
  return { ...facts, ...derived };
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
  const identity = runMode === 'on'
    ? await (io.checkEngineIdentity || checkEngineIdentity)({ token: projectsPat, config })
    : { ok: false, reason: 'not-in-on-mode' };
  const live = writesAllowed(runMode, identity);
  const fields = io.fields || (await loadOrgFields({ org: owner, token: projectsPat }));

  const rows = await list({ projectId, statusFieldId, projectsPat });
  const numbers = rows
    .map((row) => row.issue)
    .filter(
      (issue) =>
        issue &&
        issue.state === 'OPEN' &&
        issue.repository?.name === repo &&
        issue.repository?.owner?.login === owner,
    )
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
    const counters = facts.totalVotes === undefined ? {} : totalNWrite(entry.parsed.totalN, facts.totalVotes);
    actions.push({ issue: entry.number, stage: entry.parsed.stage || 'Backlog', action, counters });
    console.log(
      JSON.stringify({ event: 'pipeline_v2_action', mode: runMode, writes: live, issue: entry.number, action, counters }),
    );
    const result = await (io.applyAction || applyAction)({
      action,
      ctx: {
        owner,
        repo,
        issueNumber: entry.number,
        token: projectsPat,
        config,
        fields,
        parsed: entry.parsed,
        assignees: (entry.issue.assignees || []).map((a) => a.login),
        counters,
        facts,
        dryRun: !live,
        restFn: io.restFn,
      },
    });
    actions[actions.length - 1].applied = result.applied;
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

module.exports = { tick, buildBaseFacts, buildCommentFacts, buildWrites, countWip };
