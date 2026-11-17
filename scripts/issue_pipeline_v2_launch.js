'use strict';

/**
 * Pipeline v2 launch support (#2385 run B, P4b): the records the engine leaves on an issue when it
 * starts a Cursor run, the facts read back from them, and the launcher itself. Nothing here decides
 * anything; `decide()` reads `facts.launch` and returns a `launch` action, `applyAction` calls `launchIssue`.
 *
 * Records (engine-authored comments, the only record of a run the engine started):
 *   <!-- v2:launch run=<id> agent=<login> -->           a run was started
 *   <!-- v2:launch-failed agent=<login> -->             the API call failed (nothing started)
 *   <!-- v2:launch-acked run=<id> -->                   the run reported busy; the cycle is over
 * The newest of the three decides: an `acked` record means no launch is pending.
 */

const METHODS = ['PR', 'light-plan', 'execute-plan'];

function buildLaunchRecord({ runId, agent, agentUrl }) {
  return [
    `<!-- v2:launch run=${runId} agent=${agent} -->`,
    `Started a ${agent} run${agentUrl ? `: ${agentUrl}` : ''}. The agent has the acknowledge window to mark the issue \`busy\`.`,
  ].join('\n');
}

function buildLaunchFailed({ agent, reason }) {
  return [
    `<!-- v2:launch-failed agent=${agent} -->`,
    `Launching ${agent} failed${reason ? `: ${String(reason).slice(0, 300)}` : ''}. The engine retries with backoff.`,
  ].join('\n');
}

function buildLaunchAcked({ runId }) {
  return `<!-- v2:launch-acked run=${runId} -->\nRun ${runId} is working on this issue.`;
}

const RECORD = /<!--\s*v2:(launch|launch-failed|launch-acked)(?:\s+run=([\w.:-]+))?(?:\s+agent=([\w-]+))?\s*-->/;

/**
 * Launch facts from the issue's comments. `failures` is the `Attempts` field: it counts runs that
 * never reported busy and calls that failed, and the engine writes it on every launch.
 */
function deriveLaunchFacts({ comments, engineLogins, labels, attempts }) {
  const engine = new Set(engineLogins || []);
  const records = (comments || [])
    .filter((comment) => engine.has(comment.user?.login))
    .map((comment) => ({ comment, match: RECORD.exec(comment.body || '') }))
    .filter((entry) => entry.match)
    .sort((a, b) => a.comment.created_at.localeCompare(b.comment.created_at));
  const latest = records.at(-1);
  const busy = (labels || []).includes('busy');
  const failures = Number.isFinite(attempts) ? attempts : 0;
  if (!latest || latest.match[1] === 'launch-acked') {
    return { failures, busy };
  }
  const at = Date.parse(latest.comment.created_at);
  if (latest.match[1] === 'launch-failed') {
    return { failures, busy, lastFailureAt: at };
  }
  return { runId: latest.match[2], startedAt: at, failures, busy };
}

/** `Method:` line of the Delivery plan section; a task with none is delivered by plain PR. */
function deliveryMethod(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^#{1,4}\s*Delivery plan\s*$/i.test(line));
  if (start < 0) {
    return 'PR';
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,4}\s/.test(line));
  const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');
  const match = /^\s*Method:\s*([A-Za-z-]+)/im.exec(section);
  return (match && METHODS.find((method) => method.toLowerCase() === match[1].toLowerCase())) || 'PR';
}

/**
 * Start one Cursor run for the issue. Reuses the existing launcher and prompt builder, so the
 * run is the same as an old-engine launch. `deps` is for tests.
 */
async function launchIssue({ owner, repo, issue, token, apiKey, deps = {} }) {
  const { preflightIssue } = deps.safety || require('../.github/scripts/agent-safety-lib');
  const payloadLib = deps.payload || require('../.github/scripts/agent-payload-lib');
  const launcher = deps.launcher || require('../.github/scripts/launch-cursor-agent');
  const lib = deps.lib || require('../.github/scripts/github-project-lib');

  const labels = (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
  const preflight = preflightIssue({ title: issue.title, body: issue.body, labels: labels.map((name) => ({ name })) });
  if (!preflight.ok) {
    throw new Error(`preflight: ${preflight.reason}`);
  }
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const payload = payloadLib.buildAgentPayload(
    { number: issue.number, url: issue.html_url, title: issue.title, body: issue.body || '', labels },
    repoUrl,
  );
  const promptText = payloadLib.buildAgentPrompt(payload);

  await lib.setLabels(owner, repo, issue.number, ['busy'], [], token);
  let launched;
  try {
    launched = await launcher.launchAgent({
      apiKey,
      repoUrl,
      promptText,
      model: process.env.CURSOR_AGENT_MODEL || undefined,
    });
  } catch (error) {
    await lib.setLabels(owner, repo, issue.number, [], ['busy'], token);
    throw error;
  }
  const runId = launched.run?.id;
  if (!runId || !launched.agent?.id) {
    await lib.setLabels(owner, repo, issue.number, [], ['busy'], token);
    throw new Error('Cursor API response missing agent/run id');
  }
  return { runId, agentId: launched.agent.id, agentUrl: launched.agent.url };
}

module.exports = {
  METHODS,
  buildLaunchRecord,
  buildLaunchFailed,
  buildLaunchAcked,
  deriveLaunchFacts,
  deliveryMethod,
  launchIssue,
};
