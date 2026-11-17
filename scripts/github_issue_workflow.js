#!/usr/bin/env node
'use strict';

/**
 * GitHub issue hygiene for autonomous agents (execute-plan, babysit-plus).
 *
 *   node scripts/github_issue_workflow.js set-status --issue <n> --status "In Progress"
 *   node scripts/github_issue_workflow.js comment --issue <n> --body "..."
 *   node scripts/github_issue_workflow.js start-work --issue <n> --body "..."
 *   node scripts/github_issue_workflow.js aat-start --issue <n>
 *   node scripts/github_issue_workflow.js aat-pass --issue <n> --body-file <path> [--merge <sha>]
 *   node scripts/github_issue_workflow.js aat-fail --issue <n> --body-file <path> [--merge <sha>]
 *   node scripts/github_issue_workflow.js aat-inconclusive --issue <n> --body-file <path> [--merge <sha>]
 */

const { spawnSync } = require('child_process');
const {
  postIssueComment,
  resolveRepository,
  updateIssueProjectStatus,
} = require('./lib/execute_plan_project');
const { parseFlags, readBody } = require('./lib/github_issue_workflow_lib');
const { aatLabelPlan, appendAatMarker } = require('./lib/github_issue_workflow_aat');
const { resolveAatMergeSha } = require('./lib/github_issue_workflow_aat_merge');

const AAT_LABEL_SPECS = [
  { name: 'AAT-progress', color: 'fbca04', description: 'Agent acceptance in progress' },
  { name: 'AAT-passed', color: '0e8a16', description: 'Agent acceptance passed' },
  { name: 'AAT-failed', color: 'b60205', description: 'Agent acceptance failed' },
];

function usage() {
  console.error(`Usage:
  node scripts/github_issue_workflow.js comment --issue <n> [--body text | --body-file path]
  node scripts/github_issue_workflow.js start-work --issue <n> [--body text | --body-file path]
  node scripts/github_issue_workflow.js set-status --issue <n> --status <name>  # CI/Actions only; agents skip

  aat-start --issue <n>
  aat-pass | aat-fail | aat-inconclusive --issue <n> (--body | --body-file) [--merge <40-char-sha>]

Agents do not write the Project Status field — use comments + the \`busy\` label. See .cursor/skills/agent-acceptance/SKILL.md
See docs/agent-efficiency/github-labels.md`);
  process.exit(1);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function ensureAatLabels() {
  const { owner, repo } = resolveRepository();
  const repoSlug = `${owner}/${repo}`;
  const created = [];
  for (const spec of AAT_LABEL_SPECS) {
    const args = [
      'label',
      'create',
      spec.name,
      '--repo',
      repoSlug,
      '--color',
      spec.color,
      '--description',
      spec.description,
      '--force',
    ];
    const result = spawnSync('gh', args, { encoding: 'utf8' });
    if (result.status !== 0 && !/already exists/i.test(result.stderr || '')) {
      throw new Error(
        `gh label create failed for ${spec.name}: ${result.stderr || result.stdout}`,
      );
    }
    created.push(spec.name);
  }
  return { ok: true, labels: created };
}

function editIssueLabels(issueNumber, { add = [], remove = [] } = {}) {
  const { owner, repo } = resolveRepository();
  const args = ['issue', 'edit', String(issueNumber), '--repo', `${owner}/${repo}`];
  for (const label of add) args.push('--add-label', label);
  for (const label of remove) args.push('--remove-label', label);
  if (add.length === 0 && remove.length === 0) {
    return { skipped: true, reason: 'no_label_changes' };
  }
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `gh issue edit failed with exit ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return { ok: true, issueNumber, added: add, removed: remove };
}

function aatLabelTransition(issueNumber, outcome) {
  const { add, remove } = aatLabelPlan(outcome);
  return editIssueLabels(issueNumber, { add, remove });
}

/** Comment first (with marker), then labels. Marker is authoritative for the engine. */
async function aatVerdict({ issueNumber, outcome, verdict, flags }) {
  const body = readBody(flags);
  if (!body) {
    throw new Error('aat verdict requires --body or --body-file');
  }
  const { owner, repo } = resolveRepository();
  const mergeSha = await resolveAatMergeSha({
    issueNumber,
    owner,
    repo,
    merge: flags.merge,
  });
  const commentBody = appendAatMarker(body, verdict, mergeSha);
  const commentResult = await postIssueComment(issueNumber, commentBody);
  const labelResult =
    outcome === 'inconclusive' ? aatLabelTransition(issueNumber, 'inconclusive') : aatLabelTransition(issueNumber, outcome);
  return { mergeSha, comment: commentResult, labels: labelResult };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const issueNumber = Number(flags.issue);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) usage();

  switch (cmd) {
    case 'set-status': {
      if (!flags.status) usage();
      const result = await updateIssueProjectStatus(issueNumber, flags.status);
      printJson(result);
      process.exit(result.ok || result.skipped ? 0 : 1);
    }

    case 'comment': {
      const body = readBody(flags);
      if (!body) usage();
      printJson(await postIssueComment(issueNumber, body));
      break;
    }

    case 'start-work': {
      const body = readBody(flags) || 'Work started.';
      const commentResult = await postIssueComment(issueNumber, body);
      const labelResult = editIssueLabels(issueNumber, { add: ['busy'] });
      printJson({ comment: commentResult, labels: labelResult });
      break;
    }

    case 'aat-start': {
      const ensured = ensureAatLabels();
      const labels = aatLabelTransition(issueNumber, 'start');
      printJson({ ensureLabels: ensured, labels });
      break;
    }

    case 'aat-pass': {
      printJson(await aatVerdict({ issueNumber, outcome: 'pass', verdict: 'pass', flags }));
      break;
    }

    case 'aat-fail': {
      printJson(await aatVerdict({ issueNumber, outcome: 'fail', verdict: 'fail', flags }));
      break;
    }

    case 'aat-inconclusive': {
      printJson(
        await aatVerdict({ issueNumber, outcome: 'inconclusive', verdict: 'inconclusive', flags }),
      );
      break;
    }

    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});