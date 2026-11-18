'use strict';

/**
 * Pipeline v2 acceptance gate (#2448). Marker facts, `aatSatisfied`, and the In Main / In progress
 * rows that run when `aat.enabled` is on and both org fields exist. `decide()` stays pure: search
 * I/O and the field-missing log live in the runner.
 *
 * A verdict is actionable when a listed agent posted it for that sha, newer than the latest
 * `v2:aat-launch` for that sha, and a fail names reason=scope|implementation|quality.
 */

const { launchableAgents, selfStartingLogins } = require('./issue_pipeline_v2_config');

const FAIL_REASONS = new Set(['scope', 'implementation', 'quality']);
const MIN = 60 * 1000;
const MARKER = /<!--\s*(v2:aat(?:-relaunch|-launch|-reset|-waive)?)\b([^>]*)-->/;

function aatGateOn(facts, config) {
  return Boolean(config?.aat?.enabled && facts?.aatFieldsPresent && !facts?.isFollowUp);
}

function byTime(a, b) {
  return a.createdAt - b.createdAt || (a.id || 0) - (b.id || 0);
}

function parseAttrs(text) {
  const out = {};
  for (const match of String(text || '').matchAll(/([A-Za-z0-9_]+)=(\S+)/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

function deriveAatState({ comments, engineLogins, agentLogins }) {
  const engine = new Set(engineLogins || []);
  const agents = new Set(agentLogins || []);
  const state = { launches: [], verdicts: [], waives: [], resets: [], relaunches: [] };
  for (const comment of comments || []) {
    const match = MARKER.exec(comment.body || '');
    if (!match) continue;
    const attr = parseAttrs(match[2]);
    const sha = String(attr.merge || '').toLowerCase();
    if (!sha) continue;
    const item = {
      sha,
      createdAt: Date.parse(comment.created_at),
      id: comment.id || 0,
      login: comment.user?.login,
    };
    if (!Number.isFinite(item.createdAt)) continue;
    const kind = match[1];
    if (kind === 'v2:aat') {
      if (!agents.has(item.login)) continue;
      const verdict = attr.verdict;
      if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'inconclusive') continue;
      state.verdicts.push({ ...item, verdict, reason: String(attr.reason || '').toLowerCase() });
      continue;
    }
    if (!engine.has(item.login)) continue;
    if (kind === 'v2:aat-launch') {
      state.launches.push({ ...item, failed: attr.failed === '1', runId: attr.run || null });
    } else if (kind === 'v2:aat-reset') {
      state.resets.push(item);
    } else if (kind === 'v2:aat-waive') {
      const acceptance = String(attr.acceptance || '').toLowerCase();
      if (acceptance === 'manual' || acceptance === 'skipped') state.waives.push({ ...item, acceptance });
    } else if (kind === 'v2:aat-relaunch') {
      state.relaunches.push({ ...item, failed: attr.failed === '1' });
    }
  }
  return state;
}

function stateOf(facts) {
  return facts.aat || { launches: [], verdicts: [], waives: [], resets: [], relaunches: [] };
}

function latestOf(list, sha) {
  return (list || []).filter((item) => item.sha === sha).sort(byTime).at(-1) || null;
}

function knownFail(verdict) {
  return verdict.verdict !== 'fail' || FAIL_REASONS.has(verdict.reason);
}

/** Actionable verdicts for one sha, newest last. Compared to that sha's latest launch. */
function actionableVerdicts(state, sha) {
  const launch = latestOf(state.launches, sha);
  if (!launch) return [];
  return state.verdicts
    .filter((verdict) => verdict.sha === sha && verdict.createdAt > launch.createdAt && knownFail(verdict))
    .sort(byTime);
}

function newestActionable(state, sha) {
  return actionableVerdicts(state, sha).at(-1) || null;
}

function verdictsInWindow(state, sha, launch, next) {
  return state.verdicts.filter(
    (verdict) =>
      verdict.sha === sha &&
      verdict.createdAt > launch.createdAt &&
      (!next || verdict.createdAt < next.createdAt) &&
      knownFail(verdict),
  );
}

function launchConcluded(state, sha, launch, next, now, timeoutMs) {
  if (launch.failed) return true;
  const window = verdictsInWindow(state, sha, launch, next);
  if (window.some((verdict) => verdict.verdict === 'inconclusive')) return true;
  return window.length === 0 && now - launch.createdAt > timeoutMs;
}

function attemptBudget(state, sha, now, timeoutMin) {
  const launches = state.launches.filter((launch) => launch.sha === sha).sort(byTime);
  const timeoutMs = timeoutMin * MIN;
  let count = 0;
  for (let i = 0; i < launches.length; i += 1) {
    if (launchConcluded(state, sha, launches[i], launches[i + 1], now, timeoutMs)) count += 1;
  }
  const latest = launches.at(-1) || null;
  return {
    count,
    latest,
    latestConcluded: Boolean(latest) && launchConcluded(state, sha, latest, undefined, now, timeoutMs),
  };
}

function acceptanceValue(facts) {
  return String(facts.acceptance || '').trim().toLowerCase();
}

function waiveBinds(state, sha, acceptance) {
  return state.waives.some((waive) => waive.sha === sha && waive.acceptance === acceptance);
}

function pickAgent(candidates, facts) {
  const used = facts.agentLastUsed || {};
  let best = null;
  for (const login of candidates) {
    if (best === null || (used[login] || 0) < (used[best] || 0)) best = login;
  }
  return best;
}

function acceptancePool(facts, config) {
  const authors = new Set(facts.prAuthors || []);
  const startable = selfStartingLogins(config);
  const independent = startable.filter((login) => !authors.has(login));
  return independent.length > 0 ? independent : startable;
}

/** Newest actionable pass or fail, across shas, that supports the current field value. */
function supportingVerdict(state, value) {
  const want = value === 'passed' ? 'pass' : value === 'failed' ? 'fail' : null;
  if (!want) return null;
  const shas = new Set([...state.launches.map((launch) => launch.sha), ...state.verdicts.map((verdict) => verdict.sha)]);
  const found = [];
  for (const sha of shas) {
    const verdict = newestActionable(state, sha);
    if (verdict && verdict.verdict === want) found.push(verdict);
  }
  return found.sort(byTime).at(-1) || null;
}

function boundToSha(state, sha) {
  return Boolean(newestActionable(state, sha) || waiveBinds(state, sha, 'manual') || waiveBinds(state, sha, 'skipped'));
}

/**
 * True when acceptance has passed for this sha: an actionable pass, or a Manual/Skipped value
 * bound by a waive for this sha. A waiver outranks a newer fail. A bare Passed does not count.
 */
function aatSatisfied(facts, sha) {
  const state = stateOf(facts);
  const value = acceptanceValue(facts);
  if (value === 'manual' && waiveBinds(state, sha, 'manual')) return true;
  if (value === 'skipped' && waiveBinds(state, sha, 'skipped')) return true;
  const newest = newestActionable(state, sha);
  return Boolean(newest && newest.verdict === 'pass');
}

function passWrites(kind, value) {
  if (kind !== 'pass' || value === 'manual' || value === 'skipped') return {};
  return { acceptance: 'Passed', acceptanceFailReason: null };
}

function launchWrites(state, sha, value) {
  if (value === 'manual' || value === 'skipped') return {};
  const newest = newestActionable(state, sha);
  const passOrFail = newest && (newest.verdict === 'pass' || newest.verdict === 'fail');
  if (value === '' || value === 'pending' || ((value === 'passed' || value === 'failed') && !passOrFail)) {
    return { acceptance: 'Pending', acceptanceFailReason: null };
  }
  return {};
}

function none(reason, extra = {}) {
  return { type: 'none', reason, ...extra };
}

function quietSince(facts, config, at) {
  if (at == null || !Number.isFinite(at)) return false;
  return facts.now - at >= config.limits.stalledInactivityHours * 60 * MIN;
}

function acceptanceInMain(facts, config) {
  const sha = facts.delivery?.lastMergeSha;
  if (!sha) return none('main.no-merge');
  const state = stateOf(facts);
  const value = acceptanceValue(facts);

  if (value === 'skipped' && !waiveBinds(state, sha, 'skipped')) {
    return { type: 'aat-waive', mergeSha: sha, acceptance: 'skipped', row: 'aat.waive-skipped' };
  }
  if (value === 'manual' && !waiveBinds(state, sha, 'manual')) {
    const manuals = state.waives.filter((waive) => waive.acceptance === 'manual');
    const reset = latestOf(state.resets, sha);
    const fresh = manuals.length === 0 || (reset && manuals.every((waive) => reset.createdAt > waive.createdAt));
    if (fresh) return { type: 'aat-waive', mergeSha: sha, acceptance: 'manual', row: 'aat.waive-manual' };
  }
  if (!boundToSha(state, sha)) {
    if (value === 'passed' || value === 'failed') {
      const support = supportingVerdict(state, value);
      if (support && support.sha !== sha) {
        return {
          type: 'aat-reset',
          mergeSha: sha,
          row: 'aat.reset',
          acceptance: 'Pending',
          acceptanceFailReason: null,
        };
      }
    } else if (value === 'manual') {
      const newest = state.waives.filter((waive) => waive.acceptance === 'manual').sort(byTime).at(-1);
      const reset = latestOf(state.resets, sha);
      if (newest && newest.sha !== sha && !(reset && reset.createdAt > newest.createdAt)) {
        return {
          type: 'aat-reset',
          mergeSha: sha,
          row: 'aat.reset',
          acceptance: 'Pending',
          acceptanceFailReason: null,
        };
      }
    }
  }

  const satisfied = value === 'skipped' && waiveBinds(state, sha, 'skipped')
    ? 'skipped'
    : value === 'manual' && waiveBinds(state, sha, 'manual')
      ? 'manual'
      : newestActionable(state, sha)?.verdict === 'pass'
        ? 'pass'
        : null;
  if (satisfied) {
    const writes = passWrites(satisfied, value);
    if (facts.uatContainsLatestMerge) return { type: 'set-stage', to: 'In UAT', row: 'main.uat', ...writes };
    return none('aat.waiting-uat', writes);
  }

  const budget = attemptBudget(state, sha, facts.now, config.aat.timeoutMin);
  if (!budget.latest) {
    const pool = acceptancePool(facts, config);
    const agent = pickAgent(pool, facts);
    if (!agent) return { type: 'set-blocked', reason: 'stalled', row: 'aat.no-launchable-agent' };
    return { type: 'launch-aat', agent, mergeSha: sha, row: 'aat.launch', ...launchWrites(state, sha, value) };
  }

  const newest = newestActionable(state, sha);
  if (newest && newest.verdict === 'fail' && newest.reason === 'quality') {
    return none('aat.quality', { acceptance: 'Failed', acceptanceFailReason: 'quality' });
  }
  if (newest && newest.verdict === 'fail' && (newest.reason === 'scope' || newest.reason === 'implementation')) {
    return {
      type: 'set-stage',
      to: 'In progress',
      row: `aat.fail-${newest.reason}`,
      acceptance: 'Failed',
      acceptanceFailReason: newest.reason,
    };
  }
  if (budget.latestConcluded && budget.count < config.aat.maxInconclusive) {
    const pool = acceptancePool(facts, config);
    const agent = pickAgent(pool, facts);
    if (!agent) return { type: 'set-blocked', reason: 'stalled', row: 'aat.no-launchable-agent' };
    return { type: 'launch-aat', agent, mergeSha: sha, row: 'aat.relaunch', ...launchWrites(state, sha, value) };
  }
  if (budget.latestConcluded && budget.count >= config.aat.maxInconclusive) {
    return { type: 'set-blocked', reason: 'stalled', row: 'aat.inconclusive-cap' };
  }
  return none('aat.waiting-verdict');
}

function scopeHold(facts, config, sha) {
  const state = stateOf(facts);
  const delivery = facts.delivery || {};
  if ((delivery.openLinkedPrs || 0) > 0) return none('aat.scope-waiting');
  const relaunch = latestOf(state.relaunches, sha);
  if (relaunch?.failed) return { type: 'set-blocked', reason: 'stalled', row: 'aat.scope-relaunch-failed' };
  const quiet = quietSince(facts, config, delivery.lastActivityAt);
  if (delivery.busy && quiet) return { type: 'set-blocked', reason: 'stalled', row: 'aat.scope-quiet' };
  if (delivery.busy) return none('aat.scope-busy');
  if (!relaunch) {
    const method = facts.deliveryMethod || 'PR';
    const agent = pickAgent(launchableAgents(config, method), facts);
    if (!agent) return { type: 'set-blocked', reason: 'stalled', row: 'aat.scope-no-agent' };
    return { type: 'aat-relaunch', agent, method, mergeSha: sha, row: 'aat.scope-relaunch' };
  }
  if (quiet) return { type: 'set-blocked', reason: 'stalled', row: 'aat.scope-quiet' };
  return none('aat.scope-waiting');
}

function implementationHold(facts, config, sha) {
  if (facts.implementationSearchError) return none('aat.implementation-search-error');
  const delivery = facts.delivery || {};
  if ((facts.openFollowUps || 0) > 0 || (delivery.openLinkedPrs || 0) > 0) {
    return none('aat.implementation-waiting');
  }
  const fail = newestActionable(stateOf(facts), sha);
  if (quietSince(facts, config, fail?.createdAt)) {
    return { type: 'set-blocked', reason: 'stalled', row: 'aat.implementation-quiet' };
  }
  return none('aat.implementation-waiting');
}

/** In progress rows that suppress finished/resume. Null when this sha is not a scope or implementation fail. */
function acceptanceInProgress(facts, config) {
  if (!aatGateOn(facts, config)) return null;
  const sha = facts.delivery?.lastMergeSha;
  if (!sha) return null;
  const newest = newestActionable(stateOf(facts), sha);
  if (!newest || newest.verdict !== 'fail') return null;
  if (newest.reason === 'scope') return scopeHold(facts, config, sha);
  if (newest.reason === 'implementation') return implementationHold(facts, config, sha);
  return null;
}

function implementationFailActive(facts) {
  const sha = facts.delivery?.lastMergeSha;
  if (!sha) return false;
  const newest = newestActionable(stateOf(facts), sha);
  return Boolean(newest && newest.verdict === 'fail' && newest.reason === 'implementation');
}

function buildAatLaunch({ mergeSha, runId, failed }) {
  const marker = failed
    ? `<!-- v2:aat-launch merge=${mergeSha} failed=1 -->`
    : `<!-- v2:aat-launch merge=${mergeSha} run=${runId} -->`;
  const text = failed
    ? 'Starting acceptance failed. This counts as one concluded attempt.'
    : `Acceptance started for merge ${mergeSha}.`;
  return `${marker}\n${text}`;
}

function buildAatReset({ mergeSha }) {
  return `<!-- v2:aat-reset merge=${mergeSha} -->\nThe latest merge into \`main\` changed. Acceptance for the previous merge no longer applies.`;
}

function buildAatWaive({ mergeSha, acceptance }) {
  return `<!-- v2:aat-waive merge=${mergeSha} acceptance=${acceptance} -->\nAcceptance \`${acceptance}\` is recorded for this merge.`;
}

function buildAatRelaunch({ mergeSha, failed }) {
  const marker = failed
    ? `<!-- v2:aat-relaunch merge=${mergeSha} reason=scope failed=1 -->`
    : `<!-- v2:aat-relaunch merge=${mergeSha} reason=scope -->`;
  const text = failed
    ? 'Relaunching delivery after the acceptance scope fail failed. The issue stalls on the next tick.'
    : 'Delivery was relaunched once after an acceptance scope fail. It continues the existing programme.';
  return `${marker}\n${text}`;
}

/**
 * Open issues whose trimmed body starts with this issue's follow-up marker.
 * Search text is the marker words, not the comment wrapper. Pages are followed.
 */
async function countOpenFollowUps({ owner, repo, issueNumber, token, restFn }) {
  const marker = `<!-- v2:follow-up of=#${issueNumber} -->`;
  const q = `repo:${owner}/${repo} is:issue is:open in:body "v2:follow-up of=#${issueNumber}"`;
  const seen = new Set();
  let count = 0;
  for (let page = 1; page <= 10; page += 1) {
    const data = await restFn('GET', `/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`, token);
    const items = data?.items || [];
    for (const item of items) {
      if (seen.has(item.number)) continue;
      seen.add(item.number);
      const issue = await restFn(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${item.number}`,
        token,
      );
      if (String(issue?.body || '').trim().startsWith(marker)) count += 1;
    }
    if (items.length < 100) break;
  }
  return count;
}

module.exports = {
  aatGateOn,
  aatSatisfied,
  deriveAatState,
  acceptanceInMain,
  acceptanceInProgress,
  implementationFailActive,
  countOpenFollowUps,
  buildAatLaunch,
  buildAatReset,
  buildAatWaive,
  buildAatRelaunch,
};
