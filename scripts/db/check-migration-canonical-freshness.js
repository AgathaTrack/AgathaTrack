#!/usr/bin/env node
/**
 * Fail when up migrations change against the merge base without manifest + canonical updates.
 * Escape hatch: `-- canonical: no-schema-change` in the migration header (first ~30 lines).
 */
import path from 'path';
import { fileURLToPath } from 'url';
import {
  assertCanonicalFreshness,
  gitDiffNameOnly,
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
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--base-ref' && argv[i + 1]) {
      baseRef = argv[++i];
    } else if (argv[i] === '--head-ref' && argv[i + 1]) {
      headRef = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node scripts/db/check-migration-canonical-freshness.js --base-ref <ref> [--head-ref HEAD]');
      process.exit(0);
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  if (!baseRef) {
    fail('Usage: node scripts/db/check-migration-canonical-freshness.js --base-ref <ref> [--head-ref HEAD]');
  }
  return { baseRef, headRef };
}

function main() {
  const { baseRef, headRef } = parseArgs(process.argv);
  let base;
  try {
    base = resolveFreshnessBaseRef(baseRef, ROOT);
  } catch (err) {
    fail(err.message);
  }
  let diffFiles;
  try {
    diffFiles = gitDiffNameOnly(base.ref, headRef, ROOT, { twoDot: base.twoDot });
  } catch (err) {
    fail(err.message);
  }
  try {
    assertCanonicalFreshness(diffFiles, (rel) => readRepoFile(ROOT, rel));
  } catch (err) {
    fail(err.message);
  }
  console.log(`migration-canonical-freshness OK (base ${baseRef}, ${diffFiles.length} paths in diff)`);
}

main();