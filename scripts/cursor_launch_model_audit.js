#!/usr/bin/env node
'use strict';

/**
 * Phase-0 probe: read a Cursor agent run and print model-related fields from the API response.
 * Usage: node scripts/cursor_launch_model_audit.js --agent <id> --run <runId>
 *
 * Requires cursor_api_key or CURSOR_API_KEY in the environment.
 */

const { CURSOR_API_BASE } = require('../.github/scripts/execute-plan-launch');

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
  const path = `/v1/agents/${agent}/runs/${run}`;
  const response = await fetch(`${CURSOR_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    console.error(`GET ${path} failed (${response.status}):`, payload);
    process.exit(1);
  }
  const modelHints = {};
  for (const key of ['model', 'modelId', 'model_id']) {
    if (payload[key] != null) {
      modelHints[key] = payload[key];
    }
  }
  if (payload.agent && typeof payload.agent === 'object') {
    for (const key of ['model', 'modelId']) {
      if (payload.agent[key] != null) {
        modelHints[`agent.${key}`] = payload.agent[key];
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        event: 'cursor_launch_model_audit',
        agent,
        run,
        status: payload.status ?? null,
        modelHints,
        topLevelKeys: Object.keys(payload).sort(),
      },
      null,
      2,
    ),
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };