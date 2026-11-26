#!/usr/bin/env node
'use strict';

/**
 * Agent helper: wake pipeline v2 for one issue (analyse-issue / delivery-issue skills).
 * Dispatches issue-pipeline-v2.yml with issue_number, mission, and live flag.
 *
 * Usage:
 *   node scripts/issue_pipeline_wake.js --issue <n> --mission analyse|deliver [--live]
 *
 * Unknown arguments are refused, so a typo such as `--lvie` cannot quietly turn a live wake into a
 * preview. Requires `gh` authenticated with permission to dispatch workflows on this repo.
 */

const { spawnSync } = require('node:child_process');
const { resolveMission } = require('./issue_pipeline_mission');
const { resolveDispatchTarget } = require('./issue_pipeline_v2_dispatch');

const USAGE = 'Usage: node scripts/issue_pipeline_wake.js --issue <n> --mission analyse|deliver [--live]';

/**
 * @param {string[]} argv full process.argv
 * @returns {{ issue: string|null, mission: string, live: boolean, help: boolean, error: string|null }}
 */
function parseArgs(argv) {
  const out = { issue: null, mission: 'analyse', live: false, help: false, error: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--issue' && argv[i + 1] !== undefined) {
      out.issue = argv[++i];
    } else if (arg === '--mission' && argv[i + 1] !== undefined) {
      out.mission = argv[++i];
    } else if (arg === '--live') {
      out.live = true;
    } else if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else {
      out.error = `unknown or incomplete argument "${arg}"`;
      return out;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.error) {
    console.error(`${args.error}\n${USAGE}`);
    process.exit(1);
  }
  const target = resolveDispatchTarget(args.issue);
  if (!target.ok) {
    console.error(target.reason);
    process.exit(1);
  }
  const mission = resolveMission({ mission: args.mission, issueNumber: target.only });
  if (!mission.ok) {
    console.error(mission.reason);
    process.exit(1);
  }
  const repo = process.env.GITHUB_REPOSITORY
    || (spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { encoding: 'utf8' }).stdout || '').trim();
  if (!repo) {
    console.error('GITHUB_REPOSITORY or gh repo view required');
    process.exit(1);
  }
  const ghArgs = [
    'workflow',
    'run',
    'issue-pipeline-v2.yml',
    '--repo',
    repo,
    '-f',
    `issue_number=${target.only}`,
    '-f',
    `mission=${mission.mission}`,
    '-f',
    `live=${args.live}`,
  ];
  const result = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.exit(result.status || 1);
  }
  console.log(JSON.stringify({ event: 'pipeline_v2_wake', issue: target.only, mission: mission.mission, live: args.live, repo }));
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
