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
  const section = end < 0 ? rest : rest.slice(0, end);
  // The label must start the line (after an optional list marker, quote or table pipe) and be
  // followed by a colon or table pipe, so prose such as "the method: light-plan" is never read as
  // an instruction. Bold, backticks and table cells around the label and value are allowed:
  // `Method: PR`, `**Method:** \`light-plan\``, `| **Mechanism** | \`PR\` — ... |`.
  // The value must be a whole token: `execute-plan-beta` is not `execute-plan`.
  const field =
    /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)?\|?\s*[*_]*(?:method|mechanism)[*_]*\s*[:|][*_\s`|]*(light-plan|execute-plan|PR)(?![\w-])/i;
  for (const line of section) {
    const match = field.exec(line);
    if (match) {
      return METHODS.find((method) => method.toLowerCase() === match[1].toLowerCase());
    }
  }
  return 'PR';
}

/**
 * Start one Cursor run for the issue. Reuses the existing launcher and prompt builder, so the
 * run is the same as an old-engine launch. `deps` is for tests.
 */
const METHOD_PROMPTS = {
  PR: '',
  'light-plan':
    'Delivery method: light-plan. Deliver this issue with the procedure in `.cursor/skills/light-plan/SKILL.md` (integration branch, phase PRs, one release PR that `Refs` this issue).',
  'execute-plan':
    'Delivery method: execute-plan. Deliver this issue with the procedure in `.cursor/skills/execute-plan/SKILL.md` (a frozen v2 plan driven by `tick`).',
};

/**
 * Doorbell prompts: a run started because the engine asked an agent to work on the issue's spec or
 * review. They are not deliveries, so the issue is not marked `busy` and no PR is expected.
 */
const STAGE_PROMPTS = {
  'To do':
    'Stage task: SPEC PASS (the engine assigned you this issue; do not implement it). Read the issue and its comments. ' +
    'If there is not enough information to write a proper spec, write a best-effort spec into the issue body, ask your ' +
    'question in a comment, and set `Blocked` to `question` (agent-owned write; the engine wakes you when a human replies). ' +
    'If there is enough, write the full spec into the issue body: intent, acceptance criteria, a `## Delivery plan` section ' +
    'with a `Method:` line (`PR`, `light-plan` or `execute-plan`), the planned work, an `agent-paths` block and the ' +
    'Definition of Done checkboxes. Then react 👍 on the engine\'s latest `v2:spec-request` comment to mark the spec ready; ' +
    'the engine moves the issue to In analysis for the first adversarial review. Follow `docs/agent-efficiency/github-issue-workflow.md` §Pipeline v2.',
  'In analysis':
    'Stage task: ADVERSARIAL REVIEW (the engine assigned you this issue; do not implement it). Review the issue body as a spec: ' +
    'challenge intent, scope, delivery method, acceptance criteria and risks. If it needs changes, edit the body (your edit counts as ' +
    'your approval; the other agent must then vote) and say what changed in a comment. If it is sound, react 👍 on the engine\'s latest ' +
    '`v2:review-request` comment; if not, react 👎 with a comment explaining why. Follow `docs/agent-efficiency/github-issue-workflow.md` §Pipeline v2.',
};

async function launchIssue({ owner, repo, issue, token, apiKey, method = 'PR', stage, deps = {} }) {
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
  const extra = stage ? STAGE_PROMPTS[stage] : METHOD_PROMPTS[method];
  const promptText = [payloadLib.buildAgentPrompt(payload), extra || ''].filter(Boolean).join('\n\n');
  const mark = stage ? async () => {} : (add, remove) => lib.setLabels(owner, repo, issue.number, add, remove, token);

  await mark(['busy'], []);
  let launched;
  try {
    launched = await launcher.launchAgent({
      apiKey,
      repoUrl,
      promptText,
      model: process.env.CURSOR_AGENT_MODEL || undefined,
    });
  } catch (error) {
    await mark([], ['busy']);
    throw error;
  }
  const runId = launched.run?.id;
  if (!runId || !launched.agent?.id) {
    await mark([], ['busy']);
    throw new Error('Cursor API response missing agent/run id');
  }
  return { runId, agentId: launched.agent.id, agentUrl: launched.agent.url };
}

module.exports = {
  METHODS,
  METHOD_PROMPTS,
  STAGE_PROMPTS,
  buildLaunchRecord,
  buildLaunchFailed,
  buildLaunchAcked,
  deriveLaunchFacts,
  deliveryMethod,
  launchIssue,
};
