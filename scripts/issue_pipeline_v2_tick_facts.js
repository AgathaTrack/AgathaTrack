'use strict';

/**
 * Board-wide facts for one pipeline v2 tick (#2385), read before any issue is decided:
 *
 * - `memoComments`: one comment read per issue per tick, shared by the board pass and the
 *   per-issue facts, so the board pass costs no extra calls for issues the tick reads anyway.
 * - `countEngineWip`: issues In progress that the engine itself started. Hand-driven work
 *   (In progress without an engine launch record) never takes a pipeline slot, as #2385 says
 *   ("hand-driven programmes do not take pipeline slots"); `manual-only` is still excluded.
 * - `seedLastUsed`: when each pool id was last started, from the engine's own `v2:launch` records
 *   on the board. Pickup is then least recently used across ticks, not config order every tick
 *   (soak-5 and soak-6, #2484 / #2485). No new store: the records already exist.
 */

const { canonicalStage } = require('./issue_pipeline_v2_decide');
const { engineStartedRun } = require('./issue_pipeline_v2_release');
const { listLaunchRecords } = require('./issue_pipeline_v2_launch');
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

async function countEngineWip({ entries, commentsOf, engineLogins }) {
  const engine = new Set(engineLogins || []);
  let wip = 0;
  for (const entry of entries) {
    if (entry.closed || entry.labels.includes('manual-only') || canonicalStage(entry.stage) !== 'In progress') {
      continue;
    }
    const comments = await safeComments(commentsOf, entry);
    if (comments.some((comment) => engineStartedRun(comment, engine))) {
      wip += 1;
    }
  }
  return wip;
}

async function seedLastUsed({ entries, commentsOf, config }) {
  const lastUsed = {};
  for (const entry of entries) {
    if (!readsComments(entry)) {
      continue;
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
  }
  return lastUsed;
}

module.exports = { memoComments, readsComments, countEngineWip, seedLastUsed, COMMENT_STAGES };
