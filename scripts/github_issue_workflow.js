#!/usr/bin/env node
'use strict';

/**
 * GitHub issue hygiene for autonomous agents (execute-plan, babysit-plus).
 *
 *   node scripts/github_issue_workflow.js comment --issue <n> --body "..."
 *   node scripts/github_issue_workflow.js start-work --issue <n> --body "..."
 *   node scripts/github_issue_workflow.js finish-work --issue <n>
 *   node scripts/github_issue_workflow.js clear-queued --issue <n>
 *   node scripts/github_issue_workflow.js aat-pass --issue <n> --body-file <path> [--merge <sha>]
 *   node scripts/github_issue_workflow.js aat-fail --issue <n> --body-file <path> --reason scope|implementation|quality [--merge <sha>]
 *   node scripts/github_issue_workflow.js aat-inconclusive --issue <n> --body-file <path> [--merge <sha>]
 */

// CLI only — before any GitHub fetch: sandbox egress needs NODE_USE_ENV_PROXY at process start.
if (require.main === module) {
  require('./lib/env_proxy_reexec').reexecWithEnvProxy();
}

const {
  postIssueComment,
  resolveRepository,
} = require('./lib/execute_plan_project');
const { createGitHubClient, resolveToken, MissingToken } = require('./lib/execute_plan_github');
const { parseFlags, readBody } = require('./lib/github_issue_workflow_lib');
const { appendAatMarker, normalizeAatFailReason } = require('./lib/github_issue_workflow_aat');
const { resolveAatMergeSha } = require('./lib/github_issue_workflow_aat_merge');
const { editIssueLabels } = require('./lib/github_issue_workflow_labels');

function usage() {
  console.error(`Usage:
  node scripts/github_issue_workflow.js comment --issue <n> [--body text | --body-file path]
  node scripts/github_issue_workflow.js start-work --issue <n> [--body text | --body-file path]
  node scripts/github_issue_workflow.js finish-work --issue <n>
  node scripts/github_issue_workflow.js clear-queued --issue <n>

  aat-pass | aat-inconclusive --issue <n> (--body | --body-file) [--merge <40-char-sha>]
  aat-fail --issue <n> (--body | --body-file) --reason scope|implementation|quality [--merge <40-char-sha>]

Agents do not write the Project Status field — use comments + the \`busy\` label. See .cursor/skills/agent-acceptance/SKILL.md
See docs/agent-efficiency/github-labels.md`);
  process.exit(1);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function makeWorkflowClient() {
  const { owner, repo } = resolveRepository();
  const token = resolveToken();
  if (!token) {
    throw new MissingToken(
      'Set EXECUTE_PLAN_TOKEN, GH_TOKEN, PAWPET_CLAUDE_TOKEN (Claude Code), or GITHUB_TOKEN',
    );
  }
  return createGitHubClient({ repo: `${owner}/${repo}`, token });
}

/** Post comment with marker. Marker is authoritative for the engine. */
async function aatVerdict({ issueNumber, verdict, flags, reason }) {
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
  const commentBody = appendAatMarker(body, verdict, mergeSha, reason);
  const commentResult = await postIssueComment(issueNumber, commentBody);
  return { mergeSha, comment: commentResult };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  const issueNumber = Number(flags.issue);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) usage();

  switch (cmd) {
    case 'comment': {
      const body = readBody(flags);
      if (!body) usage();
      printJson(await postIssueComment(issueNumber, body));
      break;
    }

    case 'start-work': {
      const body = readBody(flags) || 'Work started.';
      const client = makeWorkflowClient();
      const commentResult = await postIssueComment(issueNumber, body);
      const labelResult = await editIssueLabels(client, issueNumber, { add: ['busy'] });
      printJson({ comment: commentResult, labels: labelResult });
      break;
    }

    case 'finish-work': {
      const client = makeWorkflowClient();
      const labelResult = await editIssueLabels(client, issueNumber, { remove: ['busy', 'queued'] });
      printJson({ labels: labelResult });
      break;
    }

    case 'clear-queued': {
      const client = makeWorkflowClient();
      const labelResult = await editIssueLabels(client, issueNumber, { remove: ['queued'] });
      printJson({ labels: labelResult });
      break;
    }

    case 'aat-pass': {
      printJson(await aatVerdict({ issueNumber, verdict: 'pass', flags }));
      break;
    }

    case 'aat-fail': {
      const reason = normalizeAatFailReason(flags.reason);
      printJson(await aatVerdict({ issueNumber, verdict: 'fail', flags, reason }));
      break;
    }

    case 'aat-inconclusive': {
      printJson(await aatVerdict({ issueNumber, verdict: 'inconclusive', flags }));
      break;
    }

    default:
      usage();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { aatVerdict };