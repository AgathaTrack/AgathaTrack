#!/usr/bin/env node
/**
 * Issue pipeline v2 offline test suite, discovered by filename convention.
 *
 *   node scripts/ci/run-issue-pipeline-v2-tests.mjs          # run the suite
 *   node scripts/ci/run-issue-pipeline-v2-tests.mjs --list   # print discovered files
 *
 * Every `scripts/issue_pipeline_v2*.test.js` file runs, with no list to edit.
 * Prints one summary line (suite, files, tests, pass/fail, exit) and exits non-zero
 * when the suite fails, when no test file exists, or when no tests ran.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');
export const SUITE_NAME = 'issue-pipeline-v2';
export const TEST_FILE_PATTERN = /^issue_pipeline_v2.*\.test\.js$/;

/**
 * @param {string} [dir] directory to scan (default: repo scripts/)
 * @returns {string[]} absolute paths, sorted by file name
 */
export function discoverIssuePipelineV2Tests(dir = path.join(REPO_ROOT, 'scripts')) {
  return fs
    .readdirSync(dir)
    .filter((name) => TEST_FILE_PATTERN.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Read the `# tests N` style totals from node --test TAP output.
 * Missing keys are null so a parse failure cannot look like a pass.
 * @param {string} tap
 */
export function parseTapTotals(tap) {
  const read = (key) => {
    const match = tap.match(new RegExp(`^# ${key} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return {
    tests: read('tests'),
    pass: read('pass'),
    fail: read('fail'),
    cancelled: read('cancelled'),
    skipped: read('skipped'),
    todo: read('todo'),
  };
}

/**
 * Run the suite and return the exit status plus parsed totals.
 * @param {{ files?: string[] }} [options]
 */
export function runIssuePipelineV2Suite({ files = discoverIssuePipelineV2Tests() } = {}) {
  if (files.length === 0) {
    console.error(`${SUITE_NAME}: no test files matched ${TEST_FILE_PATTERN}`);
    return { status: 1, files: 0, totals: null };
  }
  const run = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: process.env },
  );
  if (run.error) {
    console.error(`${SUITE_NAME}: failed to start node --test: ${run.error.message}`);
    return { status: 1, files: files.length, totals: null };
  }
  const stdout = run.stdout ?? '';
  process.stdout.write(stdout);
  process.stderr.write(run.stderr ?? '');

  const totals = parseTapTotals(stdout);
  const exit = run.status ?? 1;
  const noTests = totals.tests === null || totals.tests === 0;
  const status = exit !== 0 ? exit : noTests ? 1 : 0;
  const result = status === 0 ? 'PASS' : 'FAIL';
  console.log(
    `suite=${SUITE_NAME} files=${files.length} tests=${totals.tests ?? 'unparsed'} ` +
      `pass=${totals.pass ?? 'unparsed'} fail=${totals.fail ?? 'unparsed'} ` +
      `skipped=${totals.skipped ?? 'unparsed'} exit=${status} result=${result}`,
  );
  return { status, files: files.length, totals };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes('--list')) {
    for (const file of discoverIssuePipelineV2Tests()) {
      console.log(path.relative(REPO_ROOT, file));
    }
  } else {
    process.exit(runIssuePipelineV2Suite().status);
  }
}
