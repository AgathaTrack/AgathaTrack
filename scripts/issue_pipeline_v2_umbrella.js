'use strict';

/**
 * Umbrella rollup (PIPE-UMB-D-001). An umbrella is an issue with GitHub sub-issues. It moves
 * In progress → In Main and In Main → In UAT only when every sub-issue is at In Main, In UAT or Done.
 * A `Refs` link from a pull request never moves an umbrella on its own: the rollup decides.
 *
 * Pure helpers plus two readers. The caller injects the stage reader, so the engine and the legacy
 * handlers share one rule. A sub-issue closed as not planned is no blocker. A sub-issue whose stage
 * cannot be read throws, so the caller fails closed and leaves the umbrella where it is.
 */

const { rest } = require('../.github/scripts/github-project-lib');
const { loadOrgFields, parseIssueFields } = require('./issue_pipeline_v2_fields');

const READY_STAGES = new Set(['in main', 'in uat', 'done']);
const PAGE_SIZE = 100;
const MAX_PAGES = 30;

/** True when a raw Stage value lets an umbrella move on. Empty reads as Backlog, which does not. */
function isReadyStage(raw) {
  return READY_STAGES.has(String(raw || '').trim().toLowerCase());
}

/**
 * Sub-issues that hold the umbrella back. `children` items: `{ number, state, stateReason, stage }`.
 * @returns {Array<{number: number, stage: string}>}
 */
function childBlockers(children) {
  return (children || [])
    .filter((child) => !(child.state === 'closed' && child.stateReason === 'not_planned'))
    .filter((child) => !isReadyStage(child.stage))
    .map((child) => ({ number: child.number, stage: String(child.stage || '').trim() || 'Backlog' }));
}

/** Every sub-issue of an issue, with its state. Throws when the list is longer than MAX_PAGES. */
async function listSubIssues({ owner, repo, issueNumber, token, restFn = rest }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/sub_issues`;
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = (await restFn('GET', `${base}?per_page=${PAGE_SIZE}&page=${page}`, token)) || [];
    all.push(...batch);
    if (batch.length < PAGE_SIZE) {
      return all.map((issue) => ({
        number: issue.number,
        state: issue.state,
        stateReason: issue.state_reason || null,
      }));
    }
  }
  // A truncated list would under-count blockers, so it is an error, not a short answer.
  throw new Error(`sub-issue list longer than ${MAX_PAGES * PAGE_SIZE}`);
}

/**
 * The umbrella's sub-issues with their Stage, and the ones still holding it back.
 * `readStage(number)` returns the raw Stage of one sub-issue; it may throw.
 * @returns {Promise<{children: Array, blockers: Array<{number: number, stage: string}>}>}
 */
async function umbrellaRollup({ owner, repo, issueNumber, token, readStage, restFn = rest }) {
  const subs = await listSubIssues({ owner, repo, issueNumber, token, restFn });
  const children = [];
  for (const sub of subs) {
    const notPlanned = sub.state === 'closed' && sub.stateReason === 'not_planned';
    children.push({ ...sub, stage: notPlanned ? null : await readStage(sub.number) });
  }
  return { children, blockers: childBlockers(children) };
}

/**
 * Stage reader for one sub-issue, through the org fields. `fields` may be passed in; otherwise they
 * are loaded once, on the first read.
 */
function makeStageReader({ owner, repo, token, fields = null, restFn = rest }) {
  let orgFields = fields;
  return async (number) => {
    if (!orgFields) {
      orgFields = await loadOrgFields({ org: owner, token });
    }
    const issue = await restFn(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
      token,
    );
    return parseIssueFields(issue, orgFields).stage;
  };
}

/** Log text for blockers, e.g. `#2553 (To do), #2557 (In progress)`. */
function describeBlockers(blockers) {
  return blockers.map((blocker) => `#${blocker.number} (${blocker.stage})`).join(', ');
}

module.exports = {
  isReadyStage,
  childBlockers,
  listSubIssues,
  umbrellaRollup,
  makeStageReader,
  describeBlockers,
};
