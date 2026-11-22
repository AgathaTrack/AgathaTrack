#!/usr/bin/env node
'use strict';

/**
 * Pipeline v2 runner (#2385, run A). Reads the Pawpet board, builds facts per issue, calls
 * `decide()` and logs the action. Writes happen only in `on` mode with a token that is the configured engine identity.
 */

const { listProjectIssues, rest, parseRepo } = require('../.github/scripts/github-project-lib');
const { resolvePipelineMode } = require('./issue_pipeline_mode');
const { bodySha } = require('./issue_pipeline_state');
const { randomNonceHex, deriveRunSecret } = require('./issue_pipeline_v2_secrets');
const { agentLogins, applyWipOverride, loadConfig, startableIds } = require('./issue_pipeline_v2_config');
const { decide, canonicalStage } = require('./issue_pipeline_v2_decide');
const { loadOrgFields, parseIssueFields } = require('./issue_pipeline_v2_fields');
const { deliveryMethod, deriveLaunchFacts, launchIssue, doorbellRingFailed } = require('./issue_pipeline_v2_launch');
const {
  deployContains,
  deriveDeliveryFacts,
  latestDeploySha,
  listLinkedPrs,
  reopenedByEngine,
} = require('./issue_pipeline_v2_release');
const { followUpDepth, parseFollowUp } = require('./issue_pipeline_v2_intent');
const { deriveAatState, implementationFailActive, loadImplementationFollowUps } = require('./issue_pipeline_v2_acceptance');
const { applyAction, buildWrites } = require('./issue_pipeline_v2_apply');
const { checkEngineIdentity, writesAllowed } = require('./issue_pipeline_v2_identity');
const {
  deriveSpecFacts,
  latestHumanComment,
  wokenCommentIds,
  listIssueComments,
  listCommentReactions,
} = require('./issue_pipeline_v2_comments');
const { deriveReviewFacts, findReviewRequests } = require('./issue_pipeline_v2_review');
const { fetchBodyEdits, fetchCommentEditor } = require('./issue_pipeline_v2_graphql');
const { memoComments, countEngineWip, lastAssignedAgent } = require('./issue_pipeline_v2_tick_facts');
const { planRounds } = require('./issue_pipeline_v2_round_plan');

const RELEASE_STAGES = new Set(['In progress', 'In Main', 'In UAT']);

function mode() {
  return resolvePipelineMode(process.env.ISSUE_PIPELINE_V2);
}

/** Facts available from the issue itself; later phases add comments, reactions and PRs. */
function buildBaseFacts({ issue, parsed, onBoard, wip, now, runMode }) {
  const facts = {
    mode: runMode,
    now,
    onBoard,
    labels: (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)),
    stage: parsed.stage,
    blocked: parsed.blocked,
    bodyHash: bodySha(issue.body),
    wip,
  };
  if (parsed.acceptance !== undefined) facts.acceptance = parsed.acceptance;
  if (parsed.acceptanceFailReason !== undefined) facts.acceptanceFailReason = parsed.acceptanceFailReason;
  return facts;
}

/** Last editors of edited engine-authored comments (GraphQL), keyed by comment node id. */
async function resolveEditors({ comments, config, token, io }) {
  const editors = {};
  for (const comment of comments) {
    const edited = comment.updated_at && comment.updated_at !== comment.created_at;
    const byEngine = config.engine.logins.includes(comment.user?.login);
    if (edited && byEngine && /<!--\s*v2:(spec|review)-request/.test(comment.body || '')) {
      editors[comment.node_id] = await (io.fetchCommentEditor || fetchCommentEditor)({
        nodeId: comment.node_id,
        token,
      });
    }
  }
  return editors;
}

/**
 * Facts for In progress, In Main and In UAT: linked PRs, checklist, markers, and (only when the
 * stage needs it) what UAT or production has deployed. Deploy lookups are memoised per tick.
 */
async function buildReleaseFacts({ owner, repo, entry, canonical, comments, config, token, io }) {
  const prs = await (io.listLinkedPrs || listLinkedPrs)({ owner, repo, issueNumber: entry.number, token });
  const facts = {
    deliveryMethod: deliveryMethod(entry.issue.body),
    ...deriveDeliveryFacts({ issue: entry.issue, prs, comments, engineLogins: config.engine.logins }),
    deliveryLaunchAgentId: require('./issue_pipeline_v2_launch').newestDeliveryLaunchAgentId({
      comments,
      engineLogins: config.engine.logins,
    }),
  };
  const environment = { 'In Main': 'UAT', 'In UAT': 'PROD' }[canonical];
  if (environment) {
    const deploySha = await (io.deploySha || ((env) => deploys.get(env, () => latestDeploySha({ owner, repo, environment: env, token }))))(environment);
    const contains = await (io.deployContains || deployContains)({
      owner,
      repo,
      mergeSha: facts.delivery.lastMergeSha,
      deploySha,
      token,
    });
    facts[environment === 'UAT' ? 'uatContainsLatestMerge' : 'prodContainsLatestMerge'] = contains;
  }
  facts.aat = deriveAatState({
    comments,
    engineLogins: config.engine?.logins,
    agentLogins: agentLogins(config),
  });
  const gate = Boolean(
    config.aat?.enabled &&
    Object.prototype.hasOwnProperty.call(entry.parsed, 'acceptance') &&
    Object.prototype.hasOwnProperty.call(entry.parsed, 'acceptanceFailReason') &&
    !parseFollowUp(entry.issue.body),
  );
  if (gate && canonical === 'In progress' && implementationFailActive(facts)) {
    Object.assign(facts, await loadImplementationFollowUps({
      owner, repo, issueNumber: entry.number, token, restFn: io.restFn || rest, log: console.log,
    }));
  }
  return facts;
}

/** One lookup per environment per tick. */
const deploys = {
  cache: new Map(),
  reset() {
    this.cache.clear();
  },
  get(key, load) {
    if (!this.cache.has(key)) {
      this.cache.set(key, load());
    }
    return this.cache.get(key);
  },
};

/**
 * Facts that need comments, reactions or edit history. Only read for the stages that use them,
 * so a board of mostly Backlog and Done issues costs no extra calls.
 */
async function buildCommentFacts({ owner, repo, entry, config, token, io, runMode, now = Date.now() }) {
  if (entry.labels.includes('manual-only') || entry.closed) {
    return {}; // decide() ignores it (or reads only the issue itself), so spend no calls on it
  }
  const canonical = canonicalStage(entry.parsed.stage);
  const blocked = Boolean(entry.parsed.blocked);
  if (!(canonical === 'To do' || canonical === 'In analysis' || canonical === 'Ready' || RELEASE_STAGES.has(canonical) || blocked)) {
    return {};
  }
  const comments = await (io.listIssueComments || listIssueComments)({
    owner,
    repo,
    issueNumber: entry.number,
    token,
  });
  const facts = {};
  if (blocked) {
    const human = latestHumanComment(comments, config);
    facts.humanCommentSinceBlock = Boolean(human);
    facts.humanCommentId = human ? human.id : null;
    facts.wokenFor = wokenCommentIds(comments, config.engine.logins);
    return facts;
  }
  if (RELEASE_STAGES.has(canonical)) {
    return buildReleaseFacts({ owner, repo, entry, canonical, comments, config, token, io });
  }
  if (canonical === 'Ready') {
    return {
      deliveryMethod: deliveryMethod(entry.issue.body),
      launch: deriveLaunchFacts({
        comments,
        engineLogins: config.engine.logins,
        labels: entry.labels,
        attempts: entry.parsed.attempts,
      }),
    };
  }
  const editors = await resolveEditors({ comments, config, token, io });
  const engineLogins = config.engine.logins;
  const bodyHash = bodySha(entry.issue.body);
  const voteKey = process.env.PIPELINE_VOTE_KEY || '';
  const verdictCtx = {
    issueNumber: entry.number,
    bodyHash,
    voteKey,
    limits: config.limits,
    now,
  };
  const reactionsOf = (commentId) =>
    (io.listCommentReactions || listCommentReactions)({ owner, repo, commentId, token });

  if (canonical === 'To do') {
    const probe = deriveSpecFacts({ comments, reactions: [], config, engineLogins, editors, ...verdictCtx });
    const reactions = probe.commentId ? await reactionsOf(probe.commentId) : [];
    facts.spec = deriveSpecFacts({ comments, reactions, config, engineLogins, editors, ...verdictCtx });
    if (facts.spec.assignedTo && runMode === 'on') {
      facts.spec.ringFailed = await doorbellRingFailed({
        comments,
        engineLogins,
        config,
        agentId: facts.spec.assignedTo,
        stage: 'To do',
        sinceMs: facts.spec.requestedAt,
        owner,
        repo,
        token,
        io,
      });
    }
    return facts;
  }

  const requests = findReviewRequests(comments, engineLogins, editors);
  const reactionsByComment = {};
  for (const request of requests) {
    reactionsByComment[request.comment.id] = await reactionsOf(request.comment.id);
  }
  const history = await (io.fetchBodyEdits || fetchBodyEdits)({
    owner,
    repo,
    issueNumber: entry.number,
    token: io.graphqlToken || token,
  });
  const derived = deriveReviewFacts({
    comments,
    reactionsByComment,
    edits: history.edits,
    bodyAuthor: history.author,
    config,
    engineLogins,
    editors,
    ...verdictCtx,
  });
  const merged = { ...facts, ...derived };
  // P4 dry-run: the round model's answer, logged beside the live action. It never writes.
  try {
    merged.roundPlan = planRounds({
      comments,
      config,
      engineLogins,
      editors,
      bodyHash,
      voteKey,
      issueNumber: entry.number,
      limits: config.limits,
      now,
    });
  } catch (error) {
    merged.roundPlan = { error: String(error?.message ?? error).slice(0, 200) };
  }
  if (merged.review?.assignedTo && runMode === 'on') {
    merged.review.ringFailed = await doorbellRingFailed({
      comments,
      engineLogins,
      config,
      agentId: merged.review.assignedTo,
      stage: 'In analysis',
      sinceMs: merged.review.requestedAt,
      owner,
      repo,
      token,
      io,
    });
  }
  return merged;
}

async function tick({ owner, repo, token, projectsPat, projectId, statusFieldId, only, io = {} }) {
  const runMode = mode();
  if (runMode === 'off') {
    return { mode: runMode, skipped: true, reason: 'ISSUE_PIPELINE_V2 off', actions: [] };
  }
  deploys.reset();
  // WIP_LIMIT=off (repo variable) lifts the Ready queue cap for this run; see applyWipOverride.
  const config = applyWipOverride(io.config || loadConfig(), process.env.WIP_LIMIT);
  const list = io.listProjectIssues || listProjectIssues;
  const getIssue =
    io.getIssue ||
    ((number) => rest('GET', `/repos/${owner}/${repo}/issues/${number}`, projectsPat));
  const identity = runMode === 'on'
    ? await (io.checkEngineIdentity || checkEngineIdentity)({ token: projectsPat, config })
    : { ok: false, reason: 'not-in-on-mode' };
  const live = writesAllowed(runMode, identity);
  const fields = io.fields || (await loadOrgFields({ org: owner, token: projectsPat }));
  const aatFieldsPresent = Boolean(fields.acceptance && fields.acceptanceFailReason);
  if (config.aat?.enabled && !aatFieldsPresent) {
    console.log(JSON.stringify({ event: 'acceptance.field-missing' }));
  }

  const rows = await list({ projectId, statusFieldId, projectsPat, includeClosed: true });
  const numbers = rows
    .map((row) => row.issue)
    .filter(
      (issue) =>
        issue &&
        issue.state === 'OPEN' &&
        issue.repository?.name === repo &&
        issue.repository?.owner?.login === owner,
    )
    .map((issue) => issue.number);

  const entries = [];
  for (const number of numbers) {
    const issue = await getIssue(number);
    const parsed = parseIssueFields(issue, fields);
    entries.push({
      number,
      issue,
      parsed,
      stage: parsed.stage,
      labels: (issue.labels || []).map((label) => label.name || label),
    });
  }
  // Closed board items still on a delivery column (Status In progress / In Main / In UAT): a merge
  // may have auto-closed an issue that is still being delivered. Only those whose Stage is a
  // delivery stage and that were closed as completed can need reopening.
  const closedNumbers = rows
    .filter(
      (row) =>
        row.issue &&
        row.issue.state === 'CLOSED' &&
        row.issue.repository?.name === repo &&
        row.issue.repository?.owner?.login === owner &&
        ['in progress', 'in main', 'in uat'].includes(String(row.status || '').trim().toLowerCase()),
    )
    .map((row) => row.issue.number);
  for (const number of closedNumbers) {
    const issue = await getIssue(number);
    if (!issue) {
      continue;
    }
    const parsed = parseIssueFields(issue, fields);
    const labels = (issue.labels || []).map((label) => label.name || label);
    if (
      issue.state_reason === 'completed' &&
      ['In progress', 'In Main', 'In UAT'].includes(canonicalStage(parsed.stage)) &&
      !labels.includes('manual-only')
    ) {
      entries.push({ number, issue, parsed, stage: parsed.stage, labels, closed: true });
    }
  }
  // One comment read per issue per tick, shared by the board pass below and the per-issue facts.
  const listComments = memoComments(io.listIssueComments || listIssueComments);
  const tickIo = { ...io, listIssueComments: listComments };
  const commentsOf = (entry) => listComments({ owner, repo, issueNumber: entry.number, token: projectsPat });
  // WIP counts only In progress issues the engine started: hand-driven work takes no pipeline slot.
  let wip = await countEngineWip({ entries, commentsOf, engineLogins: config.engine.logins });
  // One ring for the board. Null means nothing has been assigned yet, so the next pick is the
  // first startable agent. Each in-scope assignment this tick advances the ring.
  let roundRobinAfter = await lastAssignedAgent({ entries, commentsOf, config });
  const roundRobinOrder = startableIds(config);
  const scopeLabel = io.scopeLabel !== undefined ? io.scopeLabel : process.env.ISSUE_PIPELINE_V2_LABEL || '';
  const now = Date.now();
  const actions = [];
  const errors = [];
  if (runMode === 'on' && !identity.ok) {
    // `on` with no valid engine identity writes nothing, while the legacy handlers already step
    // aside for engine-owned issues: say so loudly instead of stalling quietly.
    console.error(JSON.stringify({ event: 'pipeline_v2_error', message: `engine identity: ${identity.reason}` }));
    errors.push({ issue: null, message: `engine identity: ${identity.reason}` });
  }
  for (const entry of entries) {
    if (only && entry.number !== only) {
      continue;
    }
    const inScope = !scopeLabel || (entry.labels || []).includes(scopeLabel);
    try {
      const facts = {
        ...buildBaseFacts({
          issue: entry.issue,
          parsed: entry.parsed,
          onBoard: true,
          wip,
          now,
          runMode,
        }),
        roundRobinAfter,
        roundRobinOrder,
        aatFieldsPresent,
        isFollowUp: Boolean(parseFollowUp(entry.issue.body)),
        ...(await buildCommentFacts({ owner, repo, entry, config, token: projectsPat, io: tickIo, runMode, now })),
      };
      if (entry.closed) {
        const comments = await commentsOf(entry);
        facts.closed = true;
        facts.closeReason = entry.issue.state_reason;
        facts.reopenedBefore = reopenedByEngine(comments, config.engine.logins);
      }
      if (!String(entry.parsed.stage || '').trim() && parseFollowUp(entry.issue.body)) {
        facts.followUp = { depth: await followUpDepth({ body: entry.issue.body, getIssue }) };
      }
      const action = decide(facts, config);
      if (facts.roundPlan) {
        console.log(
          JSON.stringify({ event: 'pipeline_v2_round_plan', mode: runMode, issue: entry.number, plan: facts.roundPlan, live: action.row || action.type }),
        );
      }
      if (inScope && action.agent) {
        roundRobinAfter = action.agent;
      }
      actions.push({ issue: entry.number, stage: entry.parsed.stage || 'Backlog', action });
      console.log(
        JSON.stringify({ event: 'pipeline_v2_action', mode: runMode, writes: live && inScope, issue: entry.number, action }),
      );
      const result = await (io.applyAction || applyAction)({
        action,
        ctx: {
          owner,
          repo,
          issueNumber: entry.number,
          token: projectsPat,
          config,
          fields,
          parsed: entry.parsed,
          assignees: (entry.issue.assignees || []).map((a) => a.login),
          facts,
          // With a scope label, only labelled issues are written to; the rest are still decided and logged.
          dryRun: !live || !inScope,
          restFn: io.restFn,
          launchFn:
            io.launchFn ||
            (({ agent, method, stage, purpose = 'delivery', nonce, runSecret, mergeSha, scopeRelaunchSha }) => {
              const launchNonce = nonce || (purpose === 'delivery' ? randomNonceHex() : undefined);
              const voteKey = process.env.PIPELINE_VOTE_KEY || '';
              const secret =
                runSecret ||
                (voteKey && launchNonce ? deriveRunSecret(voteKey, entry.number, agent, stage || 'Ready', launchNonce) : '');
              return launchIssue({
                agent,
                method,
                stage,
                purpose,
                nonce: launchNonce,
                runSecret: secret,
                config,
                mergeSha,
                scopeRelaunchSha,
                owner,
                repo,
                issue: entry.issue,
                token: projectsPat,
                apiKey: process.env.CURSOR_API_KEY || process.env.cursor_api_key,
                deps: {
                  ...(io.launchDeps || {}),
                  dispatchToken: projectsPat,
                  restFn: io.restFn,
                },
              });
            }),
        },
      });
      actions[actions.length - 1].applied = result.applied;
      // The action line above is logged before it is applied, so say what actually happened. A
      // dry-run (mode, identity or scope) wrote nothing: say `planned`, never `applied`.
      if (result.applied.length > 0) {
        const event = live && inScope ? 'pipeline_v2_applied' : 'pipeline_v2_planned';
        console.log(JSON.stringify({ event, issue: entry.number, [event === 'pipeline_v2_applied' ? 'applied' : 'planned']: result.applied }));
      }
      if (inScope && result.applied.some((entry) => entry.startsWith('launch:'))) {
        wip += 1; // a started run takes a slot; a failed launch or an out-of-scope simulation does not
      }
    } catch (error) {
      // One issue's failure must not stop the rest of the board; the run still ends red.
      if (Array.isArray(error?.applied) && error.applied.length > 0) {
        const event = live && inScope ? 'pipeline_v2_applied' : 'pipeline_v2_planned';
        console.log(JSON.stringify({
          event,
          issue: entry.number,
          partial: true,
          [event === 'pipeline_v2_applied' ? 'applied' : 'planned']: error.applied,
        }));
      }
      console.error(JSON.stringify({ event: 'pipeline_v2_error', issue: entry.number, message: error?.message ?? String(error) }));
      errors.push({ issue: entry.number, message: error?.message ?? String(error) });
    }
  }
  return { mode: runMode, issueCount: entries.length, wip, actions, errors };
}

async function main() {
  const { owner, repo } = parseRepo(process.env.GITHUB_REPOSITORY || '');
  const projectsPat = process.env.GH_PROJECTS_PAT;
  const projectId = process.env.GH_PROJECT_ID;
  const statusFieldId = process.env.GH_STATUS_FIELD_ID;
  if (mode() !== 'off' && (!projectsPat || !projectId || !statusFieldId)) {
    throw new Error('GH_PROJECTS_PAT, GH_PROJECT_ID and GH_STATUS_FIELD_ID are required');
  }
  const only = process.env.ISSUE_NUMBER ? Number(process.env.ISSUE_NUMBER) : null;
  const result = await tick({
    owner,
    repo,
    token: process.env.GITHUB_TOKEN,
    projectsPat,
    projectId,
    statusFieldId,
    only,
  });
  console.log(JSON.stringify({ event: 'pipeline_v2_tick', ...result, actions: result.actions?.length }));
  if (result.errors?.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { tick, buildBaseFacts, buildCommentFacts, buildWrites };
