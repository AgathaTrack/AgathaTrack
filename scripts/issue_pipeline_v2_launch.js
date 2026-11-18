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

function buildLaunchRecord({ runId, agent, agentUrl, purpose = 'delivery', stage, nonce }) {
  const attrs = [`run=${runId}`, `agent=${agent}`];
  if (purpose) {
    attrs.push(`purpose=${purpose}`);
  }
  if (stage) {
    attrs.push(`stage=${stage}`);
  }
  if (nonce) {
    attrs.push(`nonce=${nonce}`);
  }
  const label = purpose === 'doorbell' ? 'Doorbell' : 'Delivery';
  return [
    `<!-- v2:launch ${attrs.join(' ')} -->`,
    `Started a ${label.toLowerCase()} run for \`${agent}\`${agentUrl ? `: ${agentUrl}` : ''}` +
      (purpose === 'delivery' ? '. The agent has the acknowledge window to mark the issue `busy`.' : '.'),
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

const RECORD = new RegExp(
  '<!--\\s*v2:(launch|launch-failed|launch-acked)' +
    '(?:\\s+run=([\\w.:-]+))?(?:\\s+agent=([\\w-]+))?(?:\\s+purpose=(delivery|doorbell))?' +
    '(?:\\s+stage=(To do|In analysis|In Main|In progress|Ready|In UAT|Backlog|Done))?' +
    '(?:\\s+nonce=([a-f0-9]+))?\\s*-->',
  'i',
);

/**
 * Launch facts from the issue's comments. `failures` is the `Attempts` field: it counts runs that
 * never reported busy and calls that failed, and the engine writes it on every launch.
 */
function parseLaunchComment(comment) {
  const match = RECORD.exec(comment.body || '');
  if (!match) {
    return null;
  }
  const purpose = (match[4] || 'delivery').toLowerCase();
  return {
    kind: match[1],
    runId: match[2] || null,
    agent: match[3] || null,
    purpose,
    stage: match[5] ? match[5].trim() : null,
    nonce: match[6] || null,
    at: Date.parse(comment.created_at),
    comment,
  };
}

function listLaunchRecords({ comments, engineLogins }) {
  const engine = new Set(engineLogins || []);
  return (comments || [])
    .filter((comment) => engine.has(comment.user?.login))
    .map((comment) => parseLaunchComment(comment))
    .filter(Boolean)
    .sort((a, b) => a.comment.created_at.localeCompare(b.comment.created_at));
}

function newestDeliveryLaunchAgentId({ comments, engineLogins }) {
  const delivery = listLaunchRecords({ comments, engineLogins }).filter(
    (record) => record.kind === 'launch' && record.purpose === 'delivery',
  );
  return delivery.at(-1)?.agent || null;
}

function hasDoorbellLaunchSince({ comments, engineLogins, agentId, stage, sinceMs }) {
  return listLaunchRecords({ comments, engineLogins }).some(
    (record) =>
      record.kind === 'launch' &&
      record.purpose === 'doorbell' &&
      record.agent === agentId &&
      (!stage || record.stage === stage) &&
      record.at >= sinceMs,
  );
}

function deriveLaunchFacts({ comments, engineLogins, labels, attempts }) {
  const deliveryRecords = listLaunchRecords({ comments, engineLogins }).filter((record) =>
    ['launch', 'launch-failed', 'launch-acked'].includes(record.kind) &&
    record.purpose === 'delivery',
  );
  const latest = deliveryRecords.at(-1);
  const busy = (labels || []).includes('busy');
  const failures = Number.isFinite(attempts) ? attempts : 0;
  if (!latest || latest.kind === 'launch-acked') {
    return { failures, busy };
  }
  if (latest.kind === 'launch-failed') {
    return { failures, busy, lastFailureAt: latest.at };
  }
  return { runId: latest.runId, startedAt: latest.at, failures, busy, deliveryAgentId: latest.agent };
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
  'In Main':
    'Stage task: INTENT REVIEW (the engine assigned you this issue; do not implement or edit it). Follow ' +
    '`.cursor/skills/intent-review-agent/SKILL.md`: review what shipped (the merged PRs named in the engine\'s latest ' +
    '`v2:intent-review` comment) against the issue\'s original intent, file each real finding as a follow-up issue that ' +
    'starts with `<!-- v2:follow-up of=#<this issue> -->`, post one summary comment, and react 👍 on that engine comment last.',
};

const STAGE_PROMPTS_SIGNED = {
  ...STAGE_PROMPTS,
  'To do':
    STAGE_PROMPTS['To do'].replace(
      "Then react 👍 on the engine's latest `v2:spec-request` comment to mark the spec ready;",
      'Then run `node scripts/pipeline_verdict.js read` on this issue, review the body it prints, and sign `node scripts/pipeline_verdict.js spec up --hash <hash>` when the Definition of Ready passes. Never print `PIPELINE_RUN_SECRET` or the nonce;',
    ),
  'In analysis':
    STAGE_PROMPTS['In analysis'].replace(
      'If it is sound, react 👍 on the engine\'s latest `v2:review-request` comment; if not, react 👎 with a comment explaining why.',
      'If it is sound, run `node scripts/pipeline_verdict.js read`, then `node scripts/pipeline_verdict.js review up|down --hash <hash>`. ' +
        'If you change the body, use `node scripts/pipeline_verdict.js edit --from <hash> --file <path>` only. Never print `PIPELINE_RUN_SECRET` or the nonce;',
    ),
};

function stagePromptsForConfig(config) {
  const { sharedActsAs } = require('./issue_pipeline_v2_config');
  return sharedActsAs(config).length > 0 ? STAGE_PROMPTS_SIGNED : STAGE_PROMPTS;
}

/**
 * Under pipeline v2 the approval the legacy preflight looks for is the engine's own: an issue is
 * only launched from Ready, after a converged review. The legacy labels are retired, so the
 * engine supplies them for a delivery launch. The risky-scope and blocking-label checks stay.
 * Spec, review and intent-review doorbells start no delivery and skip the preflight.
 */
const V2_APPROVAL_LABELS = ['agent-approved', 'human-reviewed'];

async function launchIssue({
  owner,
  repo,
  issue,
  token,
  apiKey,
  agent,
  method = 'PR',
  stage,
  purpose = 'delivery',
  nonce,
  runSecret,
  config,
  deps = {},
}) {
  const { preflightIssue } = deps.safety || require('../.github/scripts/agent-safety-lib');
  const lib = deps.lib || require('../.github/scripts/github-project-lib');
  const { resolveAgent } = require('./issue_pipeline_v2_config');
  const entry = resolveAgent(config, agent);
  if (!entry) {
    throw new Error(`unknown agent ${agent}`);
  }

  const labels = (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
  if (purpose === 'delivery' && !stage) {
    const preflightLabels = [...new Set([...labels, ...V2_APPROVAL_LABELS])];
    const preflight = preflightIssue({ title: issue.title, body: issue.body, labels: preflightLabels.map((name) => ({ name })) });
    if (!preflight.ok) {
      throw new Error(`preflight: ${preflight.reason}`);
    }
  }
  const mark = stage ? async () => {} : (add, remove) => lib.setLabels(owner, repo, issue.number, add, remove, token);
  await mark(['busy'], []);

  const runners = deps.runners || { cursor: require('./pipeline_runners/cursor') };
  const runner = runners[entry.runner];
  if (!runner?.launch) {
    await mark([], ['busy']);
    throw new Error(`no runner for ${entry.runner}`);
  }
  try {
    const launched = await runner.launch({
      agent: entry,
      issue,
      owner,
      repo,
      stage,
      method,
      nonce,
      runSecret,
      purpose,
      apiKey,
      config,
      deps,
    });
    return { runId: launched.runId, agentUrl: launched.agentUrl || null };
  } catch (error) {
    await mark([], ['busy']);
    throw error;
  }
}

module.exports = {
  METHODS,
  METHOD_PROMPTS,
  STAGE_PROMPTS,
  STAGE_PROMPTS_SIGNED,
  stagePromptsForConfig,
  V2_APPROVAL_LABELS,
  buildLaunchRecord,
  buildLaunchFailed,
  buildLaunchAcked,
  listLaunchRecords,
  newestDeliveryLaunchAgentId,
  hasDoorbellLaunchSince,
  deriveLaunchFacts,
  deliveryMethod,
  launchIssue,
};
