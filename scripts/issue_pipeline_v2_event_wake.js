'use strict';

/**
 * Decide whether an Actions event should start a board-wide issue-pipeline-v2 tick (#2560 P3).
 * PIPE-V2-HT-R-002 in docs/agent-efficiency/changes/pipeline-v2-holds-and-ticks.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const TRUSTED_COMMENT_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const DEPLOY_WORKFLOW_NAMES = new Set([
  'Deploy UAT (uat.agathatrack.com)',
  'Deploy Production (agathatrack.com)',
]);

const RUNNER_WORKFLOW_NAMES = new Set(['Pipeline Claude run']);

const ALWAYS_WAKE_EVENTS = new Set(['schedule', 'workflow_dispatch']);

/**
 * @param {object} opts
 * @param {string} opts.eventName
 * @param {object} opts.payload
 * @param {string[]} opts.engineLogins
 * @param {string[]} opts.agentActsAs
 */
function shouldWakeFromEvent({ eventName, payload, engineLogins, agentActsAs }) {
  const engine = new Set((engineLogins || []).map((login) => String(login).toLowerCase()));
  const agents = new Set((agentActsAs || []).map((login) => String(login).toLowerCase()));

  if (ALWAYS_WAKE_EVENTS.has(eventName)) {
    return { proceed: true, reason: 'always' };
  }

  if (eventName === 'workflow_run') {
    const run = payload.workflow_run || {};
    if (run.conclusion !== 'success') {
      return { proceed: false, reason: 'workflow_run-not-success' };
    }
    if (DEPLOY_WORKFLOW_NAMES.has(run.name || '') || RUNNER_WORKFLOW_NAMES.has(run.name || '')) {
      return { proceed: true, reason: 'workflow_run-completion' };
    }
    return { proceed: false, reason: 'workflow_run-ignored' };
  }

  if (eventName === 'pull_request') {
    const pr = payload.pull_request || {};
    if (pr.merged === true) {
      return { proceed: true, reason: 'pr-merged' };
    }
    return { proceed: false, reason: 'pr-not-merged' };
  }

  if (eventName === 'issues') {
    const login = String(payload.sender?.login || '').toLowerCase();
    if (login && engine.has(login)) {
      return { proceed: false, reason: 'engine-sender' };
    }
    return { proceed: true, reason: 'issue-activity' };
  }

  if (eventName === 'issue_comment') {
    const comment = payload.comment || {};
    const login = String(comment.user?.login || '').toLowerCase();
    if (login && engine.has(login)) {
      return { proceed: false, reason: 'engine-comment' };
    }
    const assoc = String(comment.author_association || '').toUpperCase();
    if (TRUSTED_COMMENT_ASSOCIATIONS.has(assoc)) {
      return { proceed: true, reason: 'trusted-association' };
    }
    if (login && agents.has(login)) {
      return { proceed: true, reason: 'agent-comment' };
    }
    return { proceed: false, reason: 'untrusted-comment' };
  }

  return { proceed: false, reason: 'unknown-event' };
}

function loadAgentConfig(repoRoot = path.join(__dirname, '..')) {
  const configPath = path.join(repoRoot, '.github/pipeline-agents.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const engineLogins = raw.engine?.logins || [];
  const agentActsAs = (raw.agents || [])
    .map((agent) => agent.actsAs || agent.login)
    .filter(Boolean);
  return { engineLogins, agentActsAs };
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

/** CLI for the workflow gate job: prints proceed=true|false for GITHUB_OUTPUT */
function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || 'workflow_dispatch';
  const payload = readEventPayload();
  const { engineLogins, agentActsAs } = loadAgentConfig();
  const result = shouldWakeFromEvent({ eventName, payload, engineLogins, agentActsAs });
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `proceed=${result.proceed}\n`);
    fs.appendFileSync(out, `wake_reason=${result.reason}\n`);
  }
  console.log(JSON.stringify({ event: 'pipeline_v2_wake_gate', eventName, ...result }));
  process.exit(0);
}

module.exports = { shouldWakeFromEvent, loadAgentConfig, DEPLOY_WORKFLOW_NAMES, RUNNER_WORKFLOW_NAMES };

if (require.main === module) {
  main();
}