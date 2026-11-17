'use strict';

/**
 * Pipeline v2 release readers (#2385 run B, P5): facts for the stages after Ready. Everything is
 * read, nothing is written: linked pull requests, the definition-of-done checklist, the engine's
 * own resume / intent-review markers, and what UAT and production have deployed.
 *
 * A pull request is "linked" to an issue when its body says `Refs|Closes|Fixes|Resolves #<n>` and
 * it shows up in the issue's timeline (a cross-reference). The merge that counts is a merge into
 * `main`; a phase PR merged into an integration branch is only open or closed work.
 */

const { rest } = require('../.github/scripts/github-project-lib');
const { fetchAllPages } = require('./issue_pipeline_v2_comments');

const RESUME = 'v2:resume';
const INTENT_REVIEW = 'v2:intent-review';

/** Does `body` link to the issue with a closing or `Refs` keyword? */
function linksIssue(body, issueNumber) {
  const pattern = new RegExp(`\\b(?:fixes|closes|resolves|refs)\\s+#${issueNumber}\\b`, 'i');
  return pattern.test(String(body || ''));
}

/**
 * Open pull requests that link the issue, and the merges into `main`. `restFn` is injected for tests.
 * @returns {Promise<Array<{number, state, merged, mergedAt, mergeSha, base, author, updatedAt}>>}
 */
async function listLinkedPrs({ owner, repo, issueNumber, token, restFn = rest }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const timeline = await fetchAllPages({ path: `${base}/issues/${issueNumber}/timeline`, token, restFn });
  const numbers = new Set();
  for (const event of timeline) {
    const source = event.event === 'cross-referenced' ? event.source?.issue : null;
    if (
      source?.pull_request &&
      source.repository?.name === repo &&
      (source.repository?.owner?.login || owner) === owner
    ) {
      numbers.add(source.number);
    }
  }
  const prs = [];
  for (const number of [...numbers].sort((a, b) => a - b)) {
    const pr = await restFn('GET', `${base}/pulls/${number}`, token);
    if (!linksIssue(pr.body, issueNumber)) {
      continue;
    }
    prs.push({
      number,
      state: pr.state,
      merged: Boolean(pr.merged),
      mergedAt: pr.merged_at || null,
      mergeSha: pr.merge_commit_sha || null,
      base: pr.base?.ref,
      author: pr.user?.login,
      updatedAt: pr.updated_at,
    });
  }
  return prs;
}

/** True when the checklist sections have no unticked box; no boxes at all counts as complete. */
function dodComplete(body) {
  const lines = String(body || '').split(/\r?\n/);
  let inSection = false;
  for (const line of lines) {
    const heading = /^#{1,4}\s*(.+?)\s*$/.exec(line);
    if (heading) {
      inSection = /definition of done|checklist/i.test(heading[1]);
      continue;
    }
    if (inSection && /^\s*[-*]\s+\[ \]/.test(line)) {
      return false;
    }
  }
  return true;
}

function markerNote(comment, engine, marker) {
  return (
    engine.has(comment.user?.login) &&
    new RegExp(`<!--\\s*${marker}\\b`).test(comment.body || '')
  );
}

/**
 * Delivery facts for In progress, In Main and In UAT.
 * `lastActivityAt` is the newest linked-PR update or non-engine comment: the engine's own
 * comments must not keep a stalled issue looking alive.
 */
function deriveDeliveryFacts({ issue, prs, comments, engineLogins }) {
  const engine = new Set(engineLogins || []);
  const merges = prs
    .filter((pr) => pr.merged && pr.base === 'main')
    .sort((a, b) => String(a.mergedAt).localeCompare(String(b.mergedAt)));
  const times = [
    ...prs.map((pr) => Date.parse(pr.updatedAt)),
    ...(comments || []).filter((c) => !engine.has(c.user?.login)).map((c) => Date.parse(c.created_at)),
  ].filter(Number.isFinite);
  const labels = (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
  return {
    delivery: {
      busy: labels.includes('busy'),
      dodComplete: dodComplete(issue.body),
      openLinkedPrs: prs.filter((pr) => pr.state === 'open').length,
      mergedIntoMain: merges.length,
      mergedPrNumbers: merges.map((pr) => pr.number),
      lastMergeSha: merges.at(-1)?.mergeSha || null,
      lastActivityAt: times.length > 0 ? Math.max(...times) : null,
      resumed: (comments || []).some((c) => markerNote(c, engine, RESUME)),
    },
    intentReview: { requested: (comments || []).some((c) => markerNote(c, engine, INTENT_REVIEW)) },
    prAuthors: [...new Set(prs.filter((pr) => pr.merged).map((pr) => pr.author).filter(Boolean))],
  };
}

function buildResume({ agent, ok }) {
  return [
    `<!-- ${RESUME} agent=${agent} ok=${ok ? 1 : 0} -->`,
    ok
      ? `The run on this issue went quiet, so ${agent} was started again. If it goes quiet again the issue is marked \`Blocked: stalled\`.`
      : `The run on this issue went quiet and restarting ${agent} failed. The issue is marked \`Blocked: stalled\` next.`,
  ].join('\n');
}

/**
 * The commit of the newest successful deployment to a GitHub environment (`UAT`, `PROD`), or null.
 * Deployments are the record the deploy workflows already leave by running in those environments.
 */
async function latestDeploySha({ owner, repo, environment, token, restFn = rest }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const deployments = await restFn('GET', `${base}/deployments?environment=${encodeURIComponent(environment)}&per_page=20`, token);
  for (const deployment of deployments || []) {
    const statuses = await restFn('GET', `${base}/deployments/${deployment.id}/statuses?per_page=1`, token);
    if (statuses?.[0]?.state === 'success') {
      return deployment.sha;
    }
  }
  return null;
}

/** Does `deploySha` contain `mergeSha`? Compare reports `ahead` or `identical` when it does. */
async function deployContains({ owner, repo, mergeSha, deploySha, token, restFn = rest }) {
  if (!mergeSha || !deploySha) {
    return false;
  }
  if (mergeSha === deploySha) {
    return true;
  }
  try {
    const compare = await restFn(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${mergeSha}...${deploySha}`,
      token,
    );
    return compare.status === 'ahead' || compare.status === 'identical';
  } catch {
    return false;
  }
}

module.exports = {
  RESUME,
  INTENT_REVIEW,
  linksIssue,
  listLinkedPrs,
  dodComplete,
  deriveDeliveryFacts,
  buildResume,
  latestDeploySha,
  deployContains,
};
