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

/** An intent review counts only for the merge it was requested for (a later merge needs a new one). */
function intentReviewRequested(comments, engine, mergeSha) {
  return (
    Boolean(mergeSha) &&
    (comments || []).some(
      (comment) =>
        engine.has(comment.user?.login) &&
        new RegExp(`<!--\\s*${INTENT_REVIEW}\\b[^>]*\\bmerge=${mergeSha}\\b`).test(comment.body || ''),
    )
  );
}

function markerNote(comment, engine, marker) {
  return (
    engine.has(comment.user?.login) &&
    new RegExp(`<!--\\s*${marker}\\b`).test(comment.body || '')
  );
}

/** A run the engine started: `v2:launch` or `v2:launch-acked`, never `v2:launch-failed` (nothing started). */
function engineStartedRun(comment, engine) {
  return (
    engine.has(comment.user?.login) &&
    /<!--\s*v2:launch(?:-acked)?(?![\w-])/.test(comment.body || '')
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
      // Only a run the engine started is the engine's to resume; a hand-driven issue has no record.
      engineLaunched: (comments || []).some((c) => engineStartedRun(c, engine)),
    },
    intentReview: { requested: intentReviewRequested(comments, engine, merges.at(-1)?.mergeSha) },
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

const DEPLOY_WORKFLOWS = { UAT: 'deploy-uat.yml', PROD: 'deploy-prod.yml' };

/**
 * The commit the newest successful run of a deploy workflow ran for, or null. The `UAT` / `PROD`
 * environments are also used by smoke, reset and gate jobs, so a deployment record there does not
 * mean "deployed"; a green run of the deploy workflow itself does. Its `head_sha` is the `main`
 * commit being promoted (checked against the real runs). `status=success&per_page=1` also means
 * there is nothing to page through.
 */
async function latestDeploySha({ owner, repo, environment, token, restFn = rest }) {
  const file = DEPLOY_WORKFLOWS[environment];
  if (!file) {
    throw new Error(`No deploy workflow for environment ${environment}`);
  }
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const runs = await restFn('GET', `${base}/actions/workflows/${file}/runs?status=success&branch=main&per_page=1`, token);
  return runs?.workflow_runs?.[0]?.head_sha || null;
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
