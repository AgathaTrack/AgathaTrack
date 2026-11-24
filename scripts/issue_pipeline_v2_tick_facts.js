'use strict';

/**
 * Facts for one pipeline v2 tick (#2385) that read issue comments outside `buildCommentFacts`:
 *
 * - `memoComments`: one comment read per issue per tick, shared by the board pass and the
 *   per-issue facts, so the board pass costs no extra calls for issues the tick reads anyway.
 * - `countEngineWip`: issues In progress that the engine itself started. Hand-driven work
 *   (In progress without an engine launch record) never takes a pipeline slot, as #2385 says
 *   ("hand-driven programmes do not take pipeline slots"); `manual-only` is still excluded.
 * - `lastUsedOnIssue`: when each pool id was last started on that issue. Kept for readers.
 * - `lastAssignedAgent`: the pool id on the newest engine `v2:launch` across the board. That id
 *   is who went last in the round robin. No new store.
 */

const { canonicalStage } = require('./issue_pipeline_v2_decide');
const { engineStartedRun } = require('./issue_pipeline_v2_release');
const { listLaunchRecords, deriveLaunchFacts } = require('./issue_pipeline_v2_launch');
const { resolveAgent } = require('./issue_pipeline_v2_config');

/** Stages whose facts read comments (see `buildCommentFacts`). */
const COMMENT_STAGES = new Set(['To do', 'In analysis', 'Ready', 'In progress', 'In Main', 'In UAT']);

function memoComments(listFn) {
  const cache = new Map();
  return (args) => {
    const key = args.issueNumber;
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve(listFn(args)));
    }
    return cache.get(key);
  };
}

/**
 * A failed read here must not stop the tick: the issue's own facts read the same (memoised)
 * comments inside the per-issue error handler, which reports it and moves on.
 */
async function safeComments(commentsOf, entry) {
  try {
    return (await commentsOf(entry)) || [];
  } catch {
    return [];
  }
}

function readsComments(entry) {
  if (entry.closed || entry.labels.includes('manual-only')) {
    return false;
  }
  return COMMENT_STAGES.has(canonicalStage(entry.stage)) || Boolean(entry.parsed?.blocked);
}

/**
 * Whether `v2:launch` on this board row counts toward board-wide round robin.
 * Closed rows are included when the tick keeps them for delivery columns (`issue_pipeline_v2.js`);
 * per-issue facts still use `readsComments` only.
 */
function includeInBoardLaunchHistory(entry) {
  if (entry.labels.includes('manual-only')) {
    return false;
  }
  if (entry.closed) {
    return COMMENT_STAGES.has(canonicalStage(entry.stage));
  }
  return readsComments(entry);
}

/**
 * A Ready issue whose delivery launch is in flight holds a slot: the engine launched it and either
 * the run handed off with `busy`, or it started inside the acknowledge window. A launch that failed
 * with no run, or whose window has passed unacknowledged, holds nothing.
 */
function holdsLaunchReservation({ comments, engine, labels, now, ackWindowMs }) {
  const hasDeliveryRecord = listLaunchRecords({ comments, engineLogins: [...engine] }).some(
    (record) => record.purpose === 'delivery' && ['launch', 'launch-pending', 'launch-acked'].includes(record.kind),
  );
  if (!hasDeliveryRecord) return false;
  const launch = deriveLaunchFacts({ comments, engineLogins: [...engine], labels, attempts: 0 });
  if (launch.busy) return true;
  return Boolean(launch.runId) && now - launch.startedAt < ackWindowMs;
}

/**
 * Pipeline slots in use. One count per issue, so an issue cannot hold two slots:
 * - In progress, started by the engine: holds a slot (hand-driven and manual-only work do not);
 * - Ready, with a delivery launch in flight (`holdsLaunchReservation`): holds a slot;
 * - unreadable (the comment read failed): holds a slot. A failed read never grants capacity.
 */
async function countEngineWip({ entries, commentsOf, engineLogins, now = Date.now(), ackWindowMs = 0 }) {
  const engine = new Set(engineLogins || []);
  let wip = 0;
  for (const entry of entries) {
    if (entry.closed || entry.labels.includes('manual-only')) {
      continue;
    }
    const stage = canonicalStage(entry.stage);
    if (stage !== 'In progress' && stage !== 'Ready') {
      continue;
    }
    let comments;
    try {
      comments = (await commentsOf(entry)) || [];
    } catch {
      wip += 1;
      continue;
    }
    const holds =
      stage === 'In progress'
        ? comments.some((comment) => engineStartedRun(comment, engine))
        : holdsLaunchReservation({ comments, engine, labels: entry.labels, now, ackWindowMs });
    if (holds) {
      wip += 1;
    }
  }
  return wip;
}

/**
 * Pool id on the newest engine launch on the board, or null when nothing has been started.
 * That is the round-robin cursor: the next assignment is the following startable agent.
 */
async function lastAssignedAgent({ entries, commentsOf, config }) {
  let best = null;
  let bestAt = -1;
  for (const entry of entries) {
    if (!includeInBoardLaunchHistory(entry)) {
      continue;
    }
    const comments = await safeComments(commentsOf, entry);
    for (const record of listLaunchRecords({ comments, engineLogins: config.engine.logins })) {
      if (record.kind !== 'launch' || !Number.isFinite(record.at) || record.at < bestAt) {
        continue;
      }
      const id = resolveAgent(config, record.agent)?.id;
      if (id) {
        bestAt = record.at;
        best = id;
      }
    }
  }
  return best;
}

/**
 * When each pool id was last started on this one issue, from the engine's `v2:launch` records.
 */
async function lastUsedOnIssue({ entry, commentsOf, config }) {
  const lastUsed = {};
  if (!readsComments(entry)) {
    return lastUsed;
  }
  const comments = await safeComments(commentsOf, entry);
  for (const record of listLaunchRecords({ comments, engineLogins: config.engine.logins })) {
    if (record.kind !== 'launch' || !Number.isFinite(record.at)) {
      continue;
    }
    const id = resolveAgent(config, record.agent)?.id;
    if (id && (lastUsed[id] || 0) < record.at) {
      lastUsed[id] = record.at;
    }
  }
  return lastUsed;
}

module.exports = {
  memoComments,
  readsComments,
  includeInBoardLaunchHistory,
  countEngineWip,
  lastAssignedAgent,
  lastUsedOnIssue,
  COMMENT_STAGES,
};
