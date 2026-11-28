#!/usr/bin/env node
'use strict';

/**
 * Phase-0 probe: read agent + run metadata and print any model-related API fields.
 * Usage: node scripts/cursor_launch_model_audit.js --agent <id> --run <runId>
 *
 * Requires cursor_api_key or CURSOR_API_KEY in the environment.
 * Exit 0 when model hints exist; exit 2 when both GETs succeed but no model field is present.
 */

const { auditCursorLaunchModel } = require('./lib/cursor_launch_model_audit_lib');

function parseFlags(argv) {
  const out = { agent: null, run: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--agent' && argv[i + 1]) {
      out.agent = argv[++i];
    } else if (argv[i] === '--run' && argv[i + 1]) {
      out.run = argv[++i];
    }
  }
  return out;
}

async function main() {
  const { agent, run } = parseFlags(process.argv);
  if (!agent || !run) {
    console.error('Usage: node scripts/cursor_launch_model_audit.js --agent <id> --run <runId>');
    process.exit(1);
  }
  const apiKey = process.env.cursor_api_key || process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error('cursor_api_key or CURSOR_API_KEY is required');
    process.exit(1);
  }

  const report = await auditCursorLaunchModel({ apiKey, agentId: agent, runId: run });
  if (!report.requests.agent.ok && !report.requests.run.ok) {
    console.error(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.servedModelAvailable) {
    process.exit(2);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, parseFlags };