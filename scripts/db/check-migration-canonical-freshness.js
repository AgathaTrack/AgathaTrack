#!/usr/bin/env node
/**
 * Fail when up migrations change against the merge base without manifest + canonical updates.
 * Escape hatch: `-- canonical: no-schema-change` in the migration header (first ~30 lines).
 */
import path from 'path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'url';
import {
  assertCanonicalFreshness,
  gitDiffNameOnly,
  mergePathLists,
  readRepoFile,
  resolveFreshnessBaseRef,
} from './migration-governance-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  let baseRef = null;
  let headRef = 'HEAD';
  const extraPaths = [];
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--base-ref' && argv[i + 1]) {
      baseRef = argv[++i];
    } else if (argv[i] === '--head-ref' && argv[i + 1]) {
      headRef = argv[++i];
    } else if (argv[i] === '--extra-path' && argv[i + 1]) {
      extraPaths.push(argv[++i]);
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'Usage: node scripts/db/check-migration-canonical-freshness.js --base-ref <ref> [--head-ref HEAD] [--extra-path <path>...]'
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (!baseRef) {
    fail(
      'Usage: node scripts/db/check-migration-canonical-freshness.js --base-ref <ref> [--head-ref HEAD] [--extra-path <path>...]'
    );
  }
  return { baseRef, headRef, extraPaths };
}

function resolveHeadRef(headRef, cwd) {
  const verify = spawnSync('git', ['rev-parse', '--verify', headRef], { cwd, encoding: 'utf8' });
  if (verify.status !== 0) {
    throw new Error(`migration-canonical-freshness: cannot resolve head ref "${headRef}"`);
  }
  return verify.stdout.trim();
}

function main() {
  const { baseRef, headRef, extraPaths } = parseArgs(process.argv);
  if (baseRef === 'HEAD') {
    fail('migration-canonical-freshness: invalid --base-ref HEAD (merge-base resolution failed)');
  }
  let base;
  let headResolved;
  try {
    base = resolveFreshnessBaseRef(baseRef, ROOT);
    headResolved = resolveHeadRef(headRef, ROOT);
  } catch (err) {
    fail(err.message);
  }
  if (base.ref === headResolved) {
    fail(
      'migration-canonical-freshness: base and head are the same commit — cannot compute PR diff (resolve merge-base first)'
    );
  }
  let diffFiles;
  try {
    diffFiles = gitDiffNameOnly(base.ref, headRef, ROOT, { twoDot: base.twoDot });
  } catch (err) {
    fail(err.message);
  }
  const allPaths = mergePathLists(diffFiles, extraPaths);
  try {
    assertCanonicalFreshness(allPaths, (rel) => readRepoFile(ROOT, rel));
  } catch (err) {
    fail(err.message);
  }
  console.log(`migration-canonical-freshness OK (base ${baseRef}, ${allPaths.length} paths considered)`);
}

main();