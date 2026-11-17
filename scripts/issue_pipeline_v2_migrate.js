#!/usr/bin/env node
'use strict';

/**
 * Pipeline v2 migration (#2385 run C, P7a): maps each open board issue's legacy state to the v2
 * fields. Dry-run unless `--apply` is passed, and `--apply` writes only as the engine identity.
 *
 *   Stage    empty `Stage` takes the board column (`Status`), which the Stage <-> Status mirror already
 *            keeps in step; with neither it is written as `Backlog` so the issue shows on the board.
 *            When both are set and differ the issue is reported, never changed: that is a decision.
 *   Blocked  empty `Blocked` takes a reason from the legacy labels: `question` -> question,
 *            `needs-owner` -> decision (execute-plan control issues keep `needs-owner` as runtime state).
 *
 * `plan()` is pure; the runner reads the board and applies the plan through the same field writer
 * as the engine.
 */

const { listProjectIssues, rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { canonicalStage } = require('./issue_pipeline_v2_decide');
const { loadConfig } = require('./issue_pipeline_v2_config');
const { loadOrgFields, parseIssueFields, withCurrentValues, writeIssueFields } = require('./issue_pipeline_v2_fields');
const { checkEngineIdentity } = require('./issue_pipeline_v2_identity');

const isControlIssue = (title) => /^(?:\[)?execute-plan\b/i.test(String(title || '').trim());

/**
 * @param {{ stage: string, status: string, blocked: string, labels: string[], title?: string }} issue
 * @returns {{ writes: {stage?: string, blocked?: string}, notes: string[] }}
 */
function plan({ stage, status, blocked, labels = [], title }) {
  const writes = {};
  const notes = [];
  const fromStage = String(stage || '').trim();
  const fromStatus = String(status || '').trim();

  if (!fromStage) {
    const column = fromStatus ? canonicalStage(fromStatus) : 'Backlog';
    if (column === null) {
      notes.push(`unmapped-status:${fromStatus}`);
    } else {
      writes.stage = column;
    }
  } else if (canonicalStage(fromStage) === null) {
    notes.push(`unknown-stage:${fromStage}`);
  } else if (fromStatus && canonicalStage(fromStatus) !== canonicalStage(fromStage)) {
    notes.push(`stage-status-differ:${fromStage}/${fromStatus}`);
  }

  if (!String(blocked || '').trim()) {
    if (labels.includes('question')) {
      writes.blocked = 'question';
    } else if (labels.includes('needs-owner') && !isControlIssue(title)) {
      writes.blocked = 'decision';
    }
  }
  return { writes, notes };
}

async function run({ owner, repo, projectsPat, projectId, statusFieldId, apply, io = {} }) {
  const config = io.config || loadConfig();
  if (apply) {
    const identity = await (io.checkEngineIdentity || checkEngineIdentity)({ token: projectsPat, config });
    if (!identity.ok) {
      throw new Error(`--apply needs the engine identity (${identity.reason})`);
    }
  }
  const fields = io.fields || (await loadOrgFields({ org: owner, token: projectsPat }));
  const rows = await (io.listProjectIssues || listProjectIssues)({ projectId, statusFieldId, projectsPat });
  const getIssue = io.getIssue || ((n) => rest('GET', `/repos/${owner}/${repo}/issues/${n}`, projectsPat));
  const report = [];
  for (const row of rows) {
    const ref = row.issue;
    if (!ref || ref.state !== 'OPEN' || ref.repository?.name !== repo || ref.repository?.owner?.login !== owner) {
      continue;
    }
    const issue = await getIssue(ref.number);
    const parsed = parseIssueFields(issue, fields);
    const labels = (issue.labels || []).map((label) => label.name || label);
    const { writes, notes } = plan({
      stage: parsed.stage,
      status: row.status,
      blocked: parsed.blocked,
      labels,
      title: issue.title,
    });
    const entry = { issue: ref.number, from: { stage: parsed.stage, status: row.status, blocked: parsed.blocked }, writes, notes };
    if (Object.keys(writes).length > 0 && apply) {
      await (io.writeIssueFields || writeIssueFields)({
        owner, repo, issueNumber: ref.number, token: projectsPat, fields, writes: withCurrentValues(parsed, writes), dryRun: false,
      });
      entry.applied = true;
    }
    report.push(entry);
  }
  return report;
}

async function main() {
  const { owner, repo } = parseRepo(process.env.GITHUB_REPOSITORY || '');
  const apply = process.argv.includes('--apply');
  const report = await run({
    owner,
    repo,
    projectsPat: process.env.GH_PROJECTS_PAT,
    projectId: process.env.GH_PROJECT_ID,
    statusFieldId: process.env.GH_STATUS_FIELD_ID,
    apply,
  });
  for (const entry of report) {
    console.log(JSON.stringify({ event: 'pipeline_v2_migrate', apply, ...entry }));
  }
  const changes = report.filter((entry) => Object.keys(entry.writes).length > 0).length;
  const notes = report.filter((entry) => entry.notes.length > 0).length;
  console.log(JSON.stringify({ event: 'pipeline_v2_migrate_summary', apply, issues: report.length, changes, notes }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { plan, run };
