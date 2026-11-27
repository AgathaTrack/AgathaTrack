#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

/** Fake "real gh" used in CCR shim e2e tests — refuses GraphQL and `pr *` passthrough. */
const FAKE_GH = `#!/usr/bin/env node
const routes = JSON.parse(require('fs').readFileSync(process.env.FAKE_GH_ROUTES, 'utf8'));
const args = process.argv.slice(2);
const jqAt = args.indexOf('--jq');
const key = (jqAt >= 0 ? args.slice(0, jqAt) : args).join(' ');
if (key === '--version') { console.log('gh version 0.0.0'); process.exit(0); }
if (key.startsWith('api graphql') || key.startsWith('pr ')) { console.error('HTTP 403: GitHub GraphQL is not available'); process.exit(1); }
if (!(key in routes)) { console.error('unrecorded: ' + key); process.exit(1); }
if (jqAt < 0) { process.stdout.write(JSON.stringify(routes[key])); process.exit(0); }
const jq = require('child_process').spawnSync('jq', ['-r', args[jqAt + 1]], { input: JSON.stringify(routes[key]), encoding: 'utf8' });
process.stderr.write(jq.stderr || '');
process.stdout.write(jq.stdout || '');
process.exit(jq.status ?? 1);
`;

function installFakeGh(dir, routes) {
  const fake = path.join(dir, 'fake-gh');
  const routesPath = path.join(dir, 'routes.json');
  fs.writeFileSync(fake, FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(routesPath, JSON.stringify(routes));
  return { fake, routesPath };
}

function shimEnv({ fake, routesPath, binDir }) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    REAL_GH: fake,
    FAKE_GH_ROUTES: routesPath,
  };
}

/** Parse the n-th top-level JSON value from stdout (0 = first). */
function parseJsonDocument(stdout, index = 0) {
  const trimmed = String(stdout || '').trim();
  let depth = 0;
  let start = -1;
  let seen = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        seen += 1;
        if (seen === index) {
          return JSON.parse(trimmed.slice(start, i + 1));
        }
      }
    }
  }
  throw new Error(`JSON document at index ${index} not found`);
}

function restPullBody({ slug, number, baseRef, headSha, mergeable, labels = [] }) {
  return {
    number,
    html_url: `https://github.com/${slug}/pull/${number}`,
    base: { ref: baseRef },
    head: { ref: 'feature', sha: headSha },
    labels,
    updated_at: '2026-11-27T12:00:00Z',
    title: `PR ${number}`,
    mergeable,
  };
}

function rollupRoutes(slug, sha, { green = true } = {}) {
  const check_runs = green
    ? [{ name: 'ci', status: 'completed', conclusion: 'success' }]
    : [{ name: 'ci', status: 'completed', conclusion: 'failure' }];
  return {
    [`api --paginate --slurp repos/${slug}/commits/${sha}/check-runs?per_page=100`]: [{ check_runs }],
    [`api --paginate --slurp repos/${slug}/commits/${sha}/status?per_page=100`]: [{ statuses: [] }],
  };
}

function baseCommitHotRoute(baseRef = 'release') {
  const recent = new Date().toISOString();
  return {
    [`api repos/{owner}/{repo}/commits/${baseRef}`]: {
      commit: { committer: { date: recent } },
    },
  };
}

function labelPostRoute(number) {
  return {
    [`api --method POST repos/{owner}/{repo}/issues/${number}/labels -f labels[]=merge-lease`]: {},
  };
}

function labelDeleteRoute(number) {
  return {
    [`api --method DELETE repos/{owner}/{repo}/issues/${number}/labels/merge-lease`]: {},
  };
}

function buildPreflightFifoRoutes(slug, { subject = 7, competitor = 5, baseRef = 'release' } = {}) {
  const shaSubject = 'sha-subject-7';
  const shaCompetitor = 'sha-competitor-5';
  return {
    ...baseCommitHotRoute(baseRef),
    [`api repos/${slug}/pulls/${subject}`]: restPullBody({
      slug,
      number: subject,
      baseRef,
      headSha: shaSubject,
      mergeable: true,
    }),
    [`api repos/${slug}/pulls/${competitor}`]: restPullBody({
      slug,
      number: competitor,
      baseRef,
      headSha: shaCompetitor,
      mergeable: true,
    }),
    [`api repos/${slug}/pulls?state=open&base=${baseRef}&per_page=50`]: [{ number: competitor }, { number: subject }],
    ...rollupRoutes(slug, shaSubject),
    ...rollupRoutes(slug, shaCompetitor),
  };
}

function buildPreflightClearRoutes(slug, { subject = 7, baseRef = 'release' } = {}) {
  const shaSubject = 'sha-subject-7';
  return {
    ...baseCommitHotRoute(baseRef),
    [`api repos/${slug}/pulls/${subject}`]: restPullBody({
      slug,
      number: subject,
      baseRef,
      headSha: shaSubject,
      mergeable: true,
    }),
    [`api repos/${slug}/pulls?state=open&base=${baseRef}&per_page=50`]: [],
    ...rollupRoutes(slug, shaSubject),
  };
}

module.exports = {
  FAKE_GH,
  baseCommitHotRoute,
  buildPreflightClearRoutes,
  buildPreflightFifoRoutes,
  installFakeGh,
  labelDeleteRoute,
  labelPostRoute,
  parseJsonDocument,
  restPullBody,
  rollupRoutes,
  shimEnv,
};