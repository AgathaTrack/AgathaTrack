#!/usr/bin/env node
'use strict';

const {
  fetchIssue,
  fetchAllIssueComments,
  updateProjectStatus,
  setLabels,
  upsertMarkerComment,
  assignIssue,
  reopenIssue,
  closeIssue,
  rest,
  parseRepo,
  listProjectIssues,
} = require('./github-project-lib');
const { resolveCoordinationIssue } = require('../../scripts/lib/uat_queue_sync');

const ASSIGNEE = process.env.AGENT_ASSIGNEE || 'KanopeeKa';
const { labelNames, v2Owns } = require('./pipeline-v2-owner');

const TRUSTED_UAT_BRANCH_AUTHORS = new Set(['pawpet-bot', 'pawpet-claude']);
const UAT_BRANCH_MARKER = '<!-- agent-uat-branch -->';
const MERGE_COMMIT_RE = /Merge commit:\s*`([0-9a-f]{40})`/i;

function isLightPlanTrackingIssue(issue) {
  return /^light-plan:/i.test(String(issue?.title || '').trim());
}

function lightPlanHasOpenChecklistItems(body) {
  const text = String(body || '');
  const idx = text.search(/(^|\n)#{2,4}\s*checklist/i);
  if (idx === -1) {
    return false;
  }
  return /^- \[ \]/m.test(text.slice(idx));
}

function parseTrustedMergeCommitFromComments(comments) {
  let latest = null;
  for (const comment of comments || []) {
    const author = comment.user?.login;
    const body = comment.body || '';
    if (!body.includes(UAT_BRANCH_MARKER)) {
      continue;
    }
    if (!author || !TRUSTED_UAT_BRANCH_AUTHORS.has(author)) {
      continue;
    }
    const match = MERGE_COMMIT_RE.exec(body);
    if (!match) {
      continue;
    }
    const updatedAt = comment.updated_at || comment.created_at || '';
    if (!latest || updatedAt >= latest.updatedAt) {
      latest = { mergeSha: match[1], updatedAt, commentId: comment.id };
    }
  }
  return latest?.mergeSha || null;
}

async function deployContainsMergeCommit(owner, repo, mergeSha, deploySha, token, compareFn) {
  if (!mergeSha || !deploySha || mergeSha === deploySha) {
    return mergeSha === deploySha;
  }
  try {
    const cmp = await (compareFn || ((a, b, c, d, t) =>
      rest('GET', `/repos/${a}/${b}/compare/${c}...${d}`, t)))(
      owner,
      repo,
      mergeSha,
      deploySha,
      token,
    );
    // compare base...head: `ahead` means head (deploy) contains base (merge) plus more.
    return cmp.status === 'ahead' || cmp.status === 'identical';
  } catch {
    return false;
  }
}

function parseLinkedIssues(prBody, { includeRefs = true } = {}) {
  const pattern = includeRefs
    ? /\b(?:fixes|closes|resolves|refs)\s+#(\d+)/gi
    : /\b(?:fixes|closes|resolves)\s+#(\d+)/gi;
  const matches = prBody.match(pattern) || [];
  return [...new Set(matches.map((m) => Number(m.replace(/\D/g, ''))))];
}

/**
 * Execute-plan control issue (driver programme), not a UAT ticket.
 * Light-plan tracking issues follow product release tracking (ISSUE-PIPELINE-D-002).
 */
function isPlanControlIssue(issue) {
  const title = String(issue?.title || '').trim();
  return /^(?:\[)?execute-plan\b/i.test(title);
}

/**
 * Issues the v2 engine owns (ISSUE_PIPELINE_V2=on, within the soak label if one is set) are left to
 * it: these handlers would move Status after the first merged PR, remove `busy` and reopen.
 */
function ownedByV2Engine(issue) {
  return v2Owns({ labels: labelNames(issue) });
}

function ioOr(io) {
  return {
    fetchIssue: io?.fetchIssue || fetchIssue,
    fetchAllIssueComments: io?.fetchAllIssueComments || fetchAllIssueComments,
    listProjectIssues: io?.listProjectIssues || listProjectIssues,
    compareCommits:
      io?.compareCommits ||
      ((o, r, base, head, tok) =>
        rest('GET', `/repos/${o}/${r}/compare/${base}...${head}`, tok)),
    fetchPullRequest: io?.fetchPullRequest || fetchPullRequest,
    setLabels: io?.setLabels || setLabels,
    reopenIssue: io?.reopenIssue || reopenIssue,
    updateProjectStatus: io?.updateProjectStatus || updateProjectStatus,
    upsertMarkerComment: io?.upsertMarkerComment || upsertMarkerComment,
    assignIssue: io?.assignIssue || assignIssue,
    closeIssue: io?.closeIssue || closeIssue,
    fetchPullsForCommit:
      io?.fetchPullsForCommit ||
      ((owner, repo, sha, tok) =>
        rest('GET', `/repos/${owner}/${repo}/commits/${sha}/pulls`, tok)),
  };
}

/** @param {number} prNumber @param {Date} [now] */
function uatTagName(prNumber, now = new Date()) {
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `uat-${yy}${mm}${dd}-${prNumber}`;
}

/** @param {string} ref Tag or ref name (e.g. uat-260716-193) */
function parseUatTag(ref) {
  const match = String(ref).match(/^uat-(\d{6})-(\d+)$/);
  if (!match) {
    return null;
  }
  return { yymmdd: match[1], prNumber: Number(match[2]) };
}

async function fetchPullRequest(owner, repo, prNumber, token) {
  return rest('GET', `/repos/${owner}/${repo}/pulls/${prNumber}`, token);
}

async function syncEnqueueAfterMergeSafe({
  mergeSha,
  prNumber,
  enqueuedBy,
  token,
}) {
  try {
    const { syncEnqueueAfterMerge } = require('../../scripts/lib/uat_queue_apply');
    return await syncEnqueueAfterMerge({
      mergeSha,
      prNumber: Number(prNumber),
      enqueuedBy,
      token,
    });
  } catch (error) {
    console.warn(`UAT queue enqueue skipped: ${error.message}`);
    return { skipped: true, reason: error.message };
  }
}

async function handleMergedPr({
  owner,
  repo,
  prNumber,
  prBody,
  mergeSha,
  token,
  botToken,
  projectsPat,
  projectId,
  statusFieldId,
  io,
}) {
  const api = ioOr(io);
  const issueNumbers = parseLinkedIssues(prBody || '');
  const enqueuedBy =
    issueNumbers.length > 0
      ? `issue-${issueNumbers.join(',')}`
      : `pr-${prNumber}`;
  const queueResult = await syncEnqueueAfterMergeSafe({
    mergeSha,
    prNumber,
    enqueuedBy,
    token,
  });

  if (issueNumbers.length === 0) {
    console.log(
      `PR #${prNumber} has no linked issues — UAT queue enqueue ${queueResult.skipped ? 'skipped' : 'done'}.`,
    );
    return { skipped: true, reason: 'no linked issues', queueSync: queueResult };
  }

  const expectedTag = `uat-YYMMDD-${Number(prNumber)}`;
  const results = [];
  for (const issueNumber of issueNumbers) {
    const issue = await api.fetchIssue(owner, repo, issueNumber, token);
    if (ownedByV2Engine(issue)) {
      results.push({ issueNumber, expectedTag, status: 'skipped-v2-owned' });
      console.log(`Issue #${issueNumber}: owned by the v2 engine, merge handler leaves it alone`);
      continue;
    }
    await api.setLabels(owner, repo, issueNumber, [], ['busy'], token);
    await api.reopenIssue(owner, repo, issueNumber, token);

    if (isPlanControlIssue(issue)) {
      results.push({
        issueNumber,
        expectedTag,
        status: 'reopened-plan-control',
      });
      console.log(
        `Issue #${issueNumber}: plan control issue reopened after merge auto-close; UAT status skipped`,
      );
      continue;
    }

    if (projectsPat && projectId && statusFieldId) {
      const refreshedIssue = await api.fetchIssue(owner, repo, issueNumber, token);
      await api.updateProjectStatus({
        issue: refreshedIssue,
        projectId,
        statusFieldId,
        statusName: 'In Main',
        projectsPat,
      });
    }

    // Prod notify reads the merge SHA only from a bot-authored comment (#2363 §5.1), so the
    // In Main record is written, and later edited, with the bot token.
    if (!botToken) {
      console.log(
        `Issue #${issueNumber}: EXECUTE_PLAN_BOT_TOKEN missing — In Main comment written with the Actions token; prod notify will not close this issue.`,
      );
    }
    await api.upsertMarkerComment({
      owner,
      repo,
      issueNumber,
      token: botToken || token,
      match: (comment) => TRUSTED_UAT_BRANCH_AUTHORS.has(comment?.user?.login),
      marker: '<!-- agent-uat-branch -->',
      body: `<!-- agent-uat-branch -->
## Merged to main

PR #${prNumber} merged for this issue.

- Merge commit: \`${mergeSha}\`
- Expected UAT tag: \`${expectedTag}\` (created by **Promote UAT** on push to \`main\`)
- Project status: **In Main**
- Issue reopened for UAT tracking (use **Done** after validation; do not rely on auto-close).

UAT deploy runs automatically when the tag is pushed.`,
    });

    results.push({
      issueNumber,
      expectedTag,
      status: 'In Main',
    });
    console.log(
      `Issue #${issueNumber}: reopened, status In Main, expected UAT tag ${expectedTag}`,
    );
  }

  if (!queueResult.skipped) {
    console.log(
      `UAT queue: enqueued PR #${prNumber} merge ${mergeSha} on issue #${queueResult.issueNumber}`,
    );
  }

  return { results, queueSync: queueResult };
}

async function syncUatQueueDeployResult({
  deployRef,
  conclusion,
  workflowUrl,
  token,
  prNumber,
  gateFailureClass,
  owner,
  repo,
  mergeSha,
}) {
  try {
    const { syncDeployResult } = require('../../scripts/lib/uat_queue_apply');
    const runId = process.env.GITHUB_RUN_ID || '';
    const queueResult = await syncDeployResult({
      deployRef,
      conclusion: conclusion === 'success' ? 'success' : 'failure',
      deployRunId: runId || null,
      gateSummaryRef: workflowUrl,
      gateFailureClass,
      token,
      owner,
      repo,
      mergeSha,
    });
    if (!queueResult.skipped) {
      console.log(
        `UAT queue: updated PR #${prNumber} → ${queueResult.entry.state} on issue #${queueResult.issueNumber}`,
      );
    }
    return queueResult;
  } catch (error) {
    console.warn(`UAT queue deploy sync skipped: ${error.message}`);
    return { skipped: true, reason: error.message };
  }
}

async function postCoordinationIssueUatResult({
  owner,
  repo,
  coordinationIssueNumber,
  deployRef,
  prNumber,
  conclusion,
  workflowUrl,
  gateFailureClass,
  token,
}) {
  if (!coordinationIssueNumber) {
    return { skipped: true, reason: 'coordination_issue_not_configured' };
  }

  const marker = `<!-- agent-uat-result:${deployRef} -->`;

  if (conclusion === 'success') {
    await upsertMarkerComment({
      owner,
      repo,
      issueNumber: coordinationIssueNumber,
      marker,
      body: `${marker}
## UAT deployment succeeded (PR-only merge)

Tag \`${deployRef}\` (PR #${prNumber}) deployed successfully. No product issue was linked on the merge PR.

- Workflow: ${workflowUrl}

Validate on UAT before closing related debt or roadmap items.`,
      token,
    });
    return { posted: true, outcome: 'success' };
  }

  const infraNote =
    gateFailureClass === 'infra_only'
      ? '\n\n**Infra-only failure** (WAF/deploy transport) — queue recorded as `infra_failed`. Workflow retries automatically; CI IP whitelist is not available (see `docs/e2e/uat-waf-queue-lessons.md` §17).'
      : '';

  await upsertMarkerComment({
    owner,
    repo,
    issueNumber: coordinationIssueNumber,
    marker,
    body: `${marker}
## UAT deployment failed (PR-only merge)

Tag \`${deployRef}\` (PR #${prNumber}) did not pass all gates. No product issue was linked on the merge PR — tracking on coordination issue.

- Workflow: ${workflowUrl}
- Conclusion: **${conclusion}**${infraNote}

UAT coordinator may dispatch for code failures; infra WAF blocks require operator action on o2switch Tiger Protect.`,
    token,
  });

  return { posted: true, outcome: 'failure' };
}

async function handleUatWorkflowResult({
  owner,
  repo,
  deployRef,
  conclusion,
  workflowUrl,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  gateFailureClass,
  mergeSha,
  io,
}) {
  const api = ioOr(io);
  const parsed = parseUatTag(deployRef);
  if (!parsed) {
    return { skipped: true, reason: 'deploy ref not UAT tag format' };
  }

  const queueSync = await syncUatQueueDeployResult({
    deployRef,
    conclusion,
    workflowUrl,
    token,
    prNumber: parsed.prNumber,
    gateFailureClass,
    owner,
    repo,
    mergeSha,
  });

  const pr = await api.fetchPullRequest(owner, repo, parsed.prNumber, token);
  const issueNumbers = parseLinkedIssues(pr.body || '');

  if (issueNumbers.length === 0) {
    const coordinationIssueNumber = resolveCoordinationIssue(
      process.env.UAT_COORDINATION_ISSUE,
    );
    const coordinationNote = await postCoordinationIssueUatResult({
      owner,
      repo,
      coordinationIssueNumber,
      deployRef,
      prNumber: parsed.prNumber,
      conclusion,
      workflowUrl,
      gateFailureClass,
      token,
    });
    return {
      skipped: true,
      reason: 'no linked issues',
      prNumber: parsed.prNumber,
      queueSync,
      coordinationNote,
      results: [],
    };
  }

  const results = [];
  for (const issueNumber of issueNumbers) {
    const issue = await api.fetchIssue(owner, repo, issueNumber, token);
    if (ownedByV2Engine(issue)) {
      results.push({ issueNumber, status: 'skipped-v2-owned' });
      console.log(`Issue #${issueNumber}: owned by the v2 engine, UAT notify leaves it alone`);
      continue;
    }
    if (isPlanControlIssue(issue)) {
      results.push({ issueNumber, status: 'skipped-plan-control' });
      console.log(
        `Issue #${issueNumber}: plan control issue left unchanged (UAT notify does not reopen it)`,
      );
      continue;
    }

    await api.reopenIssue(owner, repo, issueNumber, token);

    if (conclusion === 'success') {
      if (projectsPat && projectId && statusFieldId) {
        const refreshedIssue = await api.fetchIssue(owner, repo, issueNumber, token);
        await api.updateProjectStatus({
          issue: refreshedIssue,
          projectId,
          statusFieldId,
          statusName: 'In UAT',
          projectsPat,
        });
      }

      await api.upsertMarkerComment({
        owner,
        repo,
        issueNumber,
        marker: '<!-- agent-uat-result -->',
        body: `<!-- agent-uat-result -->
## UAT deployment succeeded

Tag \`${deployRef}\` (PR #${parsed.prNumber}) deployed successfully.

- Workflow: ${workflowUrl}
- Project status: **In UAT**

Validate on UAT, then move the issue to **Done** and close when complete.`,
        token,
      });

      results.push({ issueNumber, status: 'In UAT' });
      continue;
    }

    await api.setLabels(owner, repo, issueNumber, ['question'], ['human-reviewed'], token);
    await api.assignIssue(owner, repo, issueNumber, ASSIGNEE, token);

    const infraNote =
      gateFailureClass === 'infra_only'
        ? '\n\n**Infra-only failure** (WAF/deploy transport) — queue not frozen; later merges may still promote.'
        : '';

    await api.upsertMarkerComment({
      owner,
      repo,
      issueNumber,
      marker: '<!-- agent-uat-result -->',
      body: `<!-- agent-uat-result -->
## UAT deployment failed

Tag \`${deployRef}\` (PR #${parsed.prNumber}) deployment did not pass all gates.

- Workflow: ${workflowUrl}
- Conclusion: **${conclusion}**${infraNote}

Assigned @${ASSIGNEE} for investigation. The \`question\` label was added and \`human-reviewed\` was removed to pause the workflow until resolved.`,
      token,
    });

    results.push({ issueNumber, status: 'failed', assigned: ASSIGNEE });
  }

  return { prNumber: parsed.prNumber, results, queueSync };
}

/**
 * After a real production deploy + smoke (never stub/skip). Closes linked product issues.
 */
async function closeIssueAfterProd({
  api,
  owner,
  repo,
  issueNumber,
  issue,
  commitSha,
  prodTag,
  workflowUrl,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  mergeSha,
}) {
  if (projectsPat && projectId && statusFieldId) {
    const refreshedIssue = await api.fetchIssue(owner, repo, issueNumber, token);
    await api.updateProjectStatus({
      issue: refreshedIssue,
      projectId,
      statusFieldId,
      statusName: 'Done',
      projectsPat,
    });
  }

  await api.setLabels(owner, repo, issueNumber, ['in-prod'], ['busy'], token);
  await api.closeIssue(owner, repo, issueNumber, token);

  await api.upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: '<!-- agent-prod-result -->',
    body: `<!-- agent-prod-result -->
## Production deployment completed

Deploy commit \`${commitSha}\` includes delivery merge \`${mergeSha}\`.

- Prod tag: \`${prodTag || 'n/a'}\`
- Workflow: ${workflowUrl}
- Project status: **Done**
- Issue closed; \`busy\` removed.`,
    token,
  });

  return { issueNumber, mergeSha, status: 'closed' };
}

async function handleProdDeployResult({
  owner,
  repo,
  commitSha,
  prodTag,
  workflowUrl,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  io,
}) {
  const api = ioOr(io);
  const results = [];

  if (projectsPat && projectId && statusFieldId) {
    const board = await api.listProjectIssues({ projectId, statusFieldId, projectsPat });
    for (const entry of board) {
    if (entry.status !== 'In UAT') {
      continue;
    }
    const issueNumber = entry.issue?.number;
    if (!issueNumber) {
      continue;
    }
    const issue = await api.fetchIssue(owner, repo, issueNumber, token);
    if (ownedByV2Engine(issue)) {
      results.push({ issueNumber, status: 'skipped-v2-owned' });
      continue;
    }
    if (isPlanControlIssue(issue)) {
      results.push({ issueNumber, status: 'skipped-plan-control' });
      continue;
    }

    const comments = await api.fetchAllIssueComments(owner, repo, issueNumber, token);
    const mergeSha = parseTrustedMergeCommitFromComments(comments);
    if (!mergeSha) {
      results.push({ issueNumber, status: 'skipped-no-merge-comment' });
      continue;
    }

    const contained = await deployContainsMergeCommit(
      owner,
      repo,
      mergeSha,
      commitSha,
      token,
      (a, b, c, d, t) => api.compareCommits(a, b, c, d, t),
    );
    if (!contained) {
      results.push({ issueNumber, status: 'skipped-not-in-deploy' });
      continue;
    }

    if (isLightPlanTrackingIssue(issue) && lightPlanHasOpenChecklistItems(issue.body)) {
      await api.upsertMarkerComment({
        owner,
        repo,
        issueNumber,
        marker: '<!-- agent-prod-result -->',
        body: `<!-- agent-prod-result -->
## Production deploy — tracking issue left open

Deploy commit \`${commitSha}\` contains merge \`${mergeSha}\`, but the programme checklist still has open items.`,
        token,
      });
      results.push({ issueNumber, status: 'skipped-open-checklist' });
      continue;
    }

    results.push(
      await closeIssueAfterProd({
        api,
        owner,
        repo,
        issueNumber,
        issue,
        commitSha,
        prodTag,
        workflowUrl,
        token,
        projectsPat,
        projectId,
        statusFieldId,
        mergeSha,
      }),
    );
      console.log(`Issue #${issueNumber}: Done + closed (merge ${mergeSha} in deploy ${commitSha})`);
    }

    if (results.length === 0) {
      return { skipped: true, reason: 'no in-uat issues processed' };
    }
    return { commitSha, prodTag, results };
  }

  const pulls = await api.fetchPullsForCommit(owner, repo, commitSha, token);
  const prList = Array.isArray(pulls) ? pulls : [];
  if (prList.length === 0) {
    return { skipped: true, reason: 'no project config and no pull requests for commit' };
  }

  const seen = new Set();
  for (const pr of prList) {
    // #2363 §5.1: `Refs #n` is a reference, not a delivery; never close on it.
    const issueNumbers = parseLinkedIssues(pr.body || '', { includeRefs: false });
    for (const issueNumber of issueNumbers) {
      if (seen.has(issueNumber)) {
        continue;
      }
      seen.add(issueNumber);
      const issue = await api.fetchIssue(owner, repo, issueNumber, token);
      if (isPlanControlIssue(issue)) {
        results.push({ issueNumber, status: 'skipped-plan-control' });
        continue;
      }
      if (isLightPlanTrackingIssue(issue) && lightPlanHasOpenChecklistItems(issue.body)) {
        results.push({ issueNumber, status: 'skipped-open-checklist' });
        continue;
      }
      results.push(
        await closeIssueAfterProd({
          api,
          owner,
          repo,
          issueNumber,
          issue,
          commitSha,
          prodTag,
          workflowUrl,
          token,
          projectsPat,
          projectId,
          statusFieldId,
          mergeSha: commitSha,
        }),
      );
    }
  }

  if (results.length === 0) {
    return { skipped: true, reason: 'no linked product issues' };
  }
  return { commitSha, prodTag, results };
}

async function main() {
  const mode = process.env.HANDLER_MODE;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!mode || !repository || !token) {
    throw new Error('HANDLER_MODE, GITHUB_REPOSITORY, and GITHUB_TOKEN are required');
  }

  const { owner, repo } = parseRepo(repository);
  const projectsPat = process.env.GH_PROJECTS_PAT;
  const projectId = process.env.GH_PROJECT_ID;
  const statusFieldId = process.env.GH_STATUS_FIELD_ID;

  if (mode === 'pr-merged') {
    const result = await handleMergedPr({
      owner,
      repo,
      prNumber: process.env.PR_NUMBER,
      prBody: process.env.PR_BODY || '',
      mergeSha: process.env.MERGE_SHA,
      token,
      botToken: process.env.EXECUTE_PLAN_BOT_TOKEN || null,
      projectsPat,
      projectId,
      statusFieldId,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'uat-result') {
    let mergeSha = process.env.MERGE_SHA || null;
    const runId = process.env.GITHUB_RUN_ID;
    if (!mergeSha && runId) {
      try {
        const run = await rest(
          'GET',
          `/repos/${owner}/${repo}/actions/runs/${runId}`,
          token,
        );
        mergeSha = run.head_sha || null;
      } catch {
        mergeSha = null;
      }
    }

    const result = await handleUatWorkflowResult({
      owner,
      repo,
      deployRef: process.env.BRANCH_NAME || process.env.DEPLOY_REF || '',
      conclusion: process.env.WORKFLOW_CONCLUSION,
      workflowUrl: process.env.WORKFLOW_URL,
      token,
      projectsPat,
      projectId,
      statusFieldId,
      gateFailureClass: process.env.GATE_FAILURE_CLASS || null,
      mergeSha,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (mode === 'prod-result') {
    const result = await handleProdDeployResult({
      owner,
      repo,
      commitSha: process.env.COMMIT_SHA,
      prodTag: process.env.PROD_TAG || '',
      workflowUrl: process.env.WORKFLOW_URL,
      token,
      projectsPat,
      projectId,
      statusFieldId,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown HANDLER_MODE: ${mode}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  parseLinkedIssues,
  isPlanControlIssue,
  isLightPlanTrackingIssue,
  lightPlanHasOpenChecklistItems,
  parseTrustedMergeCommitFromComments,
  deployContainsMergeCommit,
  uatTagName,
  parseUatTag,
  handleMergedPr,
  handleUatWorkflowResult,
  syncUatQueueDeployResult,
  postCoordinationIssueUatResult,
  handleProdDeployResult,
};
