#!/usr/bin/env node
'use strict';

/**
 * Prod deploy guard for the acceptance gate (#2424). Runs in deploy-prod.yml before the deploy.
 *
 * Environment:
 *   AAT_GATE              off (default) | dry-run | on. Unset = off: no API calls.
 *   PROMOTED_SHA          full commit SHA being promoted
 *   GITHUB_REPOSITORY     owner/repo
 *   AAT_GATE_READ_TOKEN   read-only token (Projects read, issues read). Falls back to GITHUB_TOKEN.
 *   GH_PROJECT_ID, GH_STATUS_FIELD_ID   the engine board, as the engine reads it
 *   ISSUE_PIPELINE_V2_LABEL  optional scope label
 *   AAT_OVERRIDE_REASON   workflow_dispatch override; passes the gate and is recorded
 *   GITHUB_STEP_SUMMARY   job summary file (optional)
 *
 * Exit: 0 pass, 1 blocked (only in `on`). dry-run and any evaluation error in dry-run exit 0.
 * In `on`, an evaluation error fails closed unless an override reason is given.
 */

const fs = require('fs');
const { loadConfig } = require('../issue_pipeline_v2_config');
const { resolveMode, evaluateProdGate, renderSummary } = require('../lib/aat_prod_gate');

const SHA_PATTERN = /^[0-9a-f]{40}$/;

async function runGate({ env = process.env, collect, loadConfigFn = loadConfig, log = console.error } = {}) {
  const { mode, warning } = resolveMode(env.AAT_GATE);
  if (mode === 'off') {
    if (warning) {
      log(`::warning::${warning}`);
    }
    log('AAT_GATE off: prod acceptance guard not evaluated');
    return { exitCode: 0, mode, result: null, summary: '' };
  }
  const notes = warning ? [warning] : [];
  const promotedSha = String(env.PROMOTED_SHA || '').trim();
  const override = String(env.AAT_OVERRIDE_REASON || '').trim();

  const failOrPass = (message) => {
    if (mode === 'on' && !override) {
      log(`::error::AAT prod gate (on) failed closed: ${message}`);
      return { exitCode: 1, mode, result: null, summary: renderSummary({ mode, promotedSha, result: { wouldBlock: [], pass: false, override: '' }, notes: [...notes, `failed closed: ${message}`] }) };
    }
    log(`::warning::AAT prod gate (${mode}) could not evaluate: ${message}`);
    return { exitCode: 0, mode, result: null, summary: renderSummary({ mode, promotedSha, result: { wouldBlock: [], pass: true, override }, notes: [...notes, `could not evaluate: ${message}`] }) };
  };

  try {
    if (!SHA_PATTERN.test(promotedSha)) {
      return failOrPass('PROMOTED_SHA is missing or not a full commit SHA');
    }
    const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/');
    const token = env.AAT_GATE_READ_TOKEN || env.GITHUB_TOKEN;
    if (!owner || !repo || !token) {
      return failOrPass('GITHUB_REPOSITORY and a read token are required');
    }
    if (!env.GH_PROJECT_ID || !env.GH_STATUS_FIELD_ID) {
      return failOrPass('GH_PROJECT_ID and GH_STATUS_FIELD_ID are required');
    }
    const config = loadConfigFn();
    if (!config.aat?.enabled) {
      // The engine's In Main gate is off, so no merge has acceptance to check. No API calls.
      log('aat.enabled is false in pipeline-agents.json: prod acceptance guard not evaluated');
      return { exitCode: 0, mode, result: null, summary: '' };
    }
    const collector = collect || require('../lib/aat_prod_gate_collect').collectCandidates;
    const { gateEnabled, candidates } = await collector({
      owner,
      repo,
      promotedSha,
      token,
      projectId: env.GH_PROJECT_ID,
      statusFieldId: env.GH_STATUS_FIELD_ID,
      scopeLabel: env.ISSUE_PIPELINE_V2_LABEL || '',
      config,
    });
    if (!gateEnabled) {
      notes.push('Acceptance org fields are missing: the gate is disabled, nothing is blocked');
    }
    const result = evaluateProdGate({ mode, candidates: gateEnabled ? candidates : [], overrideReason: override });
    for (const item of result.wouldBlock) {
      const verb = mode === 'on' && !override ? 'blocks' : 'would block';
      log(`AAT prod gate ${verb} promotion: #${item.number} (${item.stage}) merge ${item.mergeSha} acceptance=${item.acceptance || 'unset'}`);
    }
    if (override) {
      notes.push(`Override reason recorded: ${override}`);
    }
    const summary = renderSummary({ mode, promotedSha, result, notes });
    if (!result.pass) {
      log(`::error::AAT prod gate blocks promotion of ${promotedSha}: ${result.blocking.map((item) => `#${item.number}`).join(', ')}`);
    }
    return { exitCode: result.pass ? 0 : 1, mode, result, summary };
  } catch (err) {
    return failOrPass(err.message);
  }
}

async function main() {
  const outcome = await runGate();
  if (outcome.summary && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${outcome.summary}\n`);
  }
  process.exitCode = outcome.exitCode;
}

if (require.main === module) {
  main().catch((err) => {
    // Only reached on a failure outside runGate: keep the same policy (dry-run never fails).
    console.error(`::error::${err.message}`);
    process.exitCode = process.env.AAT_GATE === 'on' && !process.env.AAT_OVERRIDE_REASON ? 1 : 0;
  });
}

module.exports = { runGate };
