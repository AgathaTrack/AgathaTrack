'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const {
  fetchIssue,
  assignIssue,
  setLabels,
  rest,
  upsertMarkerComment,
} = require('../.github/scripts/github-project-lib');
const { isForbiddenPath } = require('../.github/scripts/agent-safety-lib');
const { globToRegExp } = require('./lib/execute_plan_schema');
const { bodySha, defaultState, DELIVERY_LABELS } = require('./issue_pipeline_state');
const { applyReopenAnalysis } = require('./issue_pipeline_review');

const OWNER_LOGIN = 'KanopeeKa';
const DELIVERY_MARKER = '<!-- pipeline-delivery -->';
const VALID_METHODS = new Set(['PR', 'light-plan', 'execute-plan']);
const PROTECTED_GLOBS = ['.github/**', '.cursor/agent-kernel/**'];

const AGENT_PATHS_FENCE = /```agent-paths\s*\n([\s\S]*?)```/i;
const AGENT_PATHS_COMMENT = /<!--\s*agent-paths:\s*(\{[\s\S]*?\})\s*-->/i;

function coerceGlobs(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  if (Array.isArray(parsed.globs)) {
    return parsed.globs.filter((g) => typeof g === 'string' && g.trim() !== '');
  }
  if (Array.isArray(parsed.paths)) {
    return parsed.paths.filter((g) => typeof g === 'string' && g.trim() !== '');
  }
  return null;
}

/**
 * Parse planned-paths block from issue body (advisory; dispatcher fail-closes).
 * @returns {{ ok: true, globs: string[] } | { ok: false, reason: string }}
 */
function parseAgentPathsBlock(body) {
  const text = String(body ?? '');
  const fence = text.match(AGENT_PATHS_FENCE);
  if (fence) {
    try {
      const parsed = JSON.parse(fence[1].trim());
      const globs = coerceGlobs(parsed);
      if (!globs?.length) {
        return { ok: false, reason: 'invalid-agent-paths' };
      }
      return { ok: true, globs };
    } catch {
      return { ok: false, reason: 'invalid-agent-paths' };
    }
  }
  const comment = text.match(AGENT_PATHS_COMMENT);
  if (comment) {
    try {
      const parsed = JSON.parse(comment[1].trim());
      const globs = coerceGlobs(parsed);
      if (!globs?.length) {
        return { ok: false, reason: 'invalid-agent-paths' };
      }
      return { ok: true, globs };
    } catch {
      return { ok: false, reason: 'invalid-agent-paths' };
    }
  }
  return { ok: false, reason: 'missing-agent-paths' };
}

function listTrackedFiles(repoRoot) {
  const out = execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

function expandGlobs(globs, trackedFiles) {
  const matched = new Set();
  for (const file of trackedFiles) {
    for (const glob of globs) {
      if (globToRegExp(glob).test(file)) {
        matched.add(file);
      }
    }
  }
  return [...matched];
}

/**
 * Fail-closed path gate: expand globs, forbidden + protected prefixes.
 */
function evaluateDeliveryPaths(globs, trackedFiles) {
  if (!globs?.length) {
    return { ok: false, reason: 'missing-agent-paths' };
  }
  const expanded = expandGlobs(globs, trackedFiles);
  const forbiddenHits = [];
  const protectedHits = [];

  for (const file of expanded) {
    if (isForbiddenPath(file)) {
      forbiddenHits.push(file);
    }
    for (const prot of PROTECTED_GLOBS) {
      if (globToRegExp(prot).test(file)) {
        protectedHits.push(file);
      }
    }
  }

  if (forbiddenHits.length > 0 || protectedHits.length > 0) {
    return {
      ok: false,
      reason: 'sensitive-paths',
      forbiddenHits,
      protectedHits,
      expanded,
    };
  }
  return { ok: true, expanded };
}

function inferDeliveryMethod(issue, envMethod) {
  const fromEnv = String(envMethod || process.env.PIPELINE_DELIVERY_METHOD || '')
    .trim();
  if (VALID_METHODS.has(fromEnv)) {
    return fromEnv;
  }
  const title = String(issue?.title || '');
  if (/^light-plan\s*:/i.test(title)) {
    return 'light-plan';
  }
  if (/^execute-plan\s*:/i.test(title)) {
    return 'execute-plan';
  }
  return 'PR';
}

/**
 * Pure delivery outcome before GitHub writes.
 */
function decideDeliveryPlan({
  method,
  pathCheck,
  bodyEditedThisStep,
  liveBodySha,
  stateBodySha,
}) {
  if (!VALID_METHODS.has(method)) {
    return { kind: 'needs-owner', owner_reason: 'invalid-delivery-method' };
  }
  if (bodyEditedThisStep && stateBodySha && liveBodySha !== stateBodySha) {
    return { kind: 'reopen', reason: 'body-changed-during-delivery' };
  }
  if (!pathCheck.ok) {
    return {
      kind: 'needs-owner',
      owner_reason: pathCheck.reason || 'sensitive-paths',
      pathCheck,
    };
  }
  return { kind: 'queued', method, label: method };
}

function buildStateMarker(state) {
  return `<!-- agent-state: ${JSON.stringify(state)} -->`;
}

async function clearAssignees(owner, repo, issueNumber, token) {
  await rest('POST', `/repos/${owner}/${repo}/issues/${issueNumber}/assignees`, token, {
    assignees: [],
  });
}

async function applyDeliveryNeedsOwner({
  owner,
  repo,
  issueNumber,
  token,
  assignToken,
  state,
  liveBodySha,
  owner_reason,
  pathCheck,
}) {
  const nextState = {
    ...defaultState(),
    ...state,
    body_sha: liveBodySha,
    owner_reason,
    converged_at: state.converged_at || null,
    delivery: null,
  };

  await setLabels(owner, repo, issueNumber, ['needs-owner'], [], token);
  await assignIssue(owner, repo, issueNumber, OWNER_LOGIN, assignToken || token);
  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: DELIVERY_MARKER,
    body: `${DELIVERY_MARKER}
## Delivery path gate failed

Reason: **${owner_reason}**.

${pathCheck?.forbiddenHits?.length ? `Forbidden: ${pathCheck.forbiddenHits.join(', ')}\n` : ''}${pathCheck?.protectedHits?.length ? `Protected: ${pathCheck.protectedHits.join(', ')}\n` : ''}

${buildStateMarker(nextState)}`,
    token,
  });

  return { kind: 'needs-owner', assignee: OWNER_LOGIN, state: nextState, owner_reason };
}

/**
 * P6 delivery stub: method from \`PIPELINE_DELIVERY_METHOD\` or title heuristic; path gate always runs.
 */
async function applyDeliveryStub({
  owner,
  repo,
  issueNumber,
  token,
  projectsPat,
  projectId,
  statusFieldId,
  assignToken,
  state,
  liveBodySha,
  dryRun,
  repoRoot = path.join(__dirname, '..'),
}) {
  const issue = await fetchIssue(owner, repo, issueNumber, token);
  const method = inferDeliveryMethod(issue, process.env.PIPELINE_DELIVERY_METHOD);
  const bodyEditedThisStep = process.env.PIPELINE_DELIVERY_BODY_EDIT === 'true';

  const parsed = parseAgentPathsBlock(issue.body || '');
  const pathCheck = parsed.ok
    ? evaluateDeliveryPaths(parsed.globs, listTrackedFiles(repoRoot))
    : { ok: false, reason: parsed.reason };

  const plan = decideDeliveryPlan({
    method,
    pathCheck,
    bodyEditedThisStep,
    liveBodySha,
    stateBodySha: state.body_sha,
  });

  if (dryRun) {
    return { dryRun: true, action: 'delivery', method, pathCheck, plan };
  }

  if (plan.kind === 'reopen') {
    return applyReopenAnalysis({
      owner,
      repo,
      issueNumber,
      token,
      projectsPat,
      projectId,
      statusFieldId,
      assignToken,
      state,
      liveBodySha,
      dryRun: false,
    });
  }

  if (plan.kind === 'needs-owner') {
    return applyDeliveryNeedsOwner({
      owner,
      repo,
      issueNumber,
      token,
      assignToken,
      state,
      liveBodySha,
      owner_reason: plan.owner_reason,
      pathCheck,
    });
  }

  const deliveryRemoves = (issue.labels?.nodes || issue.labels || [])
    .map((n) => (typeof n === 'string' ? n : n.name))
    .filter((n) => DELIVERY_LABELS.has(n) && n !== plan.label);

  if (deliveryRemoves.length > 0) {
    await setLabels(owner, repo, issueNumber, [], deliveryRemoves, token);
  }
  await setLabels(owner, repo, issueNumber, [plan.label], [], token);
  await clearAssignees(owner, repo, issueNumber, assignToken || token);

  const nextState = {
    ...defaultState(),
    ...state,
    body_sha: liveBodySha,
    delivery: plan.method,
    owner_reason: null,
    converged_at: state.converged_at,
    verdicts: state.verdicts || {},
    round: state.round,
  };

  await upsertMarkerComment({
    owner,
    repo,
    issueNumber,
    marker: DELIVERY_MARKER,
    body: `${DELIVERY_MARKER}
## Delivery (${plan.method})

Path gate: **pass** (${pathCheck.expanded?.length ?? 0} tracked file(s) matched).

Queued for implement — unassigned, label **${plan.label}**.

${buildStateMarker(nextState)}`,
    token,
  });

  return { kind: 'queued', method: plan.method, state: nextState, status: 'Ready' };
}

module.exports = {
  DELIVERY_MARKER,
  VALID_METHODS,
  PROTECTED_GLOBS,
  parseAgentPathsBlock,
  listTrackedFiles,
  expandGlobs,
  evaluateDeliveryPaths,
  inferDeliveryMethod,
  decideDeliveryPlan,
  applyDeliveryStub,
};