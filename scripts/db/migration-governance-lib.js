/**
 * Shared helpers for migration manifest / canonical governance (no DB).
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'node:child_process';

export const CANONICAL_NO_SCHEMA_MARKER = '-- canonical: no-schema-change';
const UP_MIGRATION = /^db\/migrations\/\d{3}_[^/]+\.sql$/;
const DOWN_SUFFIX = '_down.sql';

export function parseCodeMigrationKeysFromMigrateSource(source) {
  const match = source.match(/const\s+CODE_MIGRATIONS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) {
    throw new Error('migration-governance: CODE_MIGRATIONS block not found in migrate.js');
  }
  const keys = [];
  const keyRe = /['"](\d{3}_[^'"]+\.sql)['"]\s*:/g;
  let m;
  while ((m = keyRe.exec(match[1])) !== null) {
    keys.push(m[1]);
  }
  if (keys.length === 0) {
    throw new Error('migration-governance: no CODE_MIGRATIONS keys parsed');
  }
  return [...new Set(keys)].sort();
}

export function assertCodeMigrationsParity(manifestCodeMigrations, migrateKeys) {
  const manifestSet = new Set(manifestCodeMigrations || []);
  const migrateSet = new Set(migrateKeys);
  const missingInManifest = migrateKeys.filter((k) => !manifestSet.has(k));
  const extraInManifest = [...manifestSet].filter((k) => !migrateSet.has(k));
  if (missingInManifest.length || extraInManifest.length) {
    const parts = [];
    if (missingInManifest.length) {
      parts.push(`manifest code_migrations missing: ${missingInManifest.join(', ')}`);
    }
    if (extraInManifest.length) {
      parts.push(`manifest code_migrations extra (not in CODE_MIGRATIONS): ${extraInManifest.join(', ')}`);
    }
    throw new Error(`migration-manifest: ${parts.join('; ')}`);
  }
}

export function filterUpMigrationPaths(diffFiles) {
  return diffFiles.filter((f) => {
    if (!UP_MIGRATION.test(f)) return false;
    if (f.endsWith(DOWN_SUFFIX)) return false;
    return true;
  });
}

export function migrationHasNoSchemaChangeMarker(fileContents) {
  const head = String(fileContents).split('\n').slice(0, 30).join('\n');
  return head.includes(CANONICAL_NO_SCHEMA_MARKER);
}

/**
 * @param {string[]} diffFiles paths from git diff --name-only
 * @param {(relPath: string) => string | null} readText
 */
export function assertCanonicalFreshness(diffFiles, readText) {
  const changed = new Set(diffFiles);
  const upMigrations = filterUpMigrationPaths(diffFiles);
  const needsCompanion = [];
  for (const rel of upMigrations) {
    const text = readText(rel);
    if (text == null) {
      throw new Error(`migration-canonical-freshness: cannot read ${rel}`);
    }
    if (migrationHasNoSchemaChangeMarker(text)) continue;
    needsCompanion.push(rel);
  }
  if (needsCompanion.length === 0) return;

  const hasManifest = changed.has('db/schema/migration-manifest.json');
  const hasCanonical = changed.has('db/schema/canonical.sql');
  if (!hasManifest || !hasCanonical) {
    const missing = [];
    if (!hasManifest) missing.push('db/schema/migration-manifest.json');
    if (!hasCanonical) missing.push('db/schema/canonical.sql');
    throw new Error(
      `migration-canonical-freshness: migration SQL changed (${needsCompanion.join(', ')}) ` +
        `but required updates missing: ${missing.join(', ')}`
    );
  }
}

const SHA40 = /^[0-9a-f]{40}$/i;

export function readPrBaseShaFromGithubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    return payload.pull_request?.base?.sha || null;
  } catch {
    return null;
  }
}

export function ensureCommitAvailable(sha, cwd) {
  if (!SHA40.test(String(sha))) {
    throw new Error(`migration-canonical-freshness: expected 40-char commit SHA, got "${sha}"`);
  }
  let verify = spawnSync('git', ['rev-parse', '--verify', sha], { cwd, encoding: 'utf8' });
  if (verify.status === 0) return sha;
  const fetch = spawnSync('git', ['fetch', '--depth=1', 'origin', sha], { cwd, encoding: 'utf8' });
  if (fetch.status !== 0) {
    throw new Error(
      `migration-canonical-freshness: cannot fetch PR base commit ${sha} (${fetch.stderr || fetch.stdout || ''})`
    );
  }
  verify = spawnSync('git', ['rev-parse', '--verify', sha], { cwd, encoding: 'utf8' });
  if (verify.status !== 0) {
    throw new Error(`migration-canonical-freshness: PR base commit ${sha} not available after fetch`);
  }
  return sha;
}

/**
 * Prefer explicit PR base SHA in Actions (shallow checkout) over merge-base three-dot diff.
 */
export function resolveFreshnessBaseRef(explicitBaseRef, cwd) {
  const prBase =
    process.env.MIGRATION_LINT_BASE_SHA ||
    process.env.GITHUB_EVENT_PULL_REQUEST_BASE_SHA ||
    readPrBaseShaFromGithubEvent();
  if (prBase) {
    return { ref: ensureCommitAvailable(prBase, cwd), twoDot: true };
  }
  const resolved = resolveGitBaseRef(explicitBaseRef, cwd);
  return { ref: resolved, twoDot: SHA40.test(resolved) };
}

export function resolveGitBaseRef(baseRef, cwd) {
  let verify = spawnSync('git', ['rev-parse', '--verify', baseRef], {
    cwd,
    encoding: 'utf8',
  });
  if (verify.status === 0) {
    return verify.stdout.trim();
  }
  const fetch = spawnSync('git', ['fetch', 'origin', baseRef, '--depth=1'], {
    cwd,
    encoding: 'utf8',
  });
  if (fetch.status !== 0) {
    throw new Error(
      `migration-canonical-freshness: cannot resolve base ref "${baseRef}" (git rev-parse and fetch failed)`
    );
  }
  verify = spawnSync('git', ['rev-parse', '--verify', `origin/${baseRef}`], {
    cwd,
    encoding: 'utf8',
  });
  if (verify.status !== 0) {
    verify = spawnSync('git', ['rev-parse', '--verify', 'FETCH_HEAD'], { cwd, encoding: 'utf8' });
  }
  if (verify.status !== 0) {
    throw new Error(`migration-canonical-freshness: cannot resolve base ref "${baseRef}" after fetch`);
  }
  return verify.stdout.trim();
}

export function gitDiffNameOnly(baseResolved, headRef, cwd, { twoDot = false } = {}) {
  const range = twoDot ? `${baseResolved}..${headRef}` : `${baseResolved}...${headRef}`;
  const diff = spawnSync('git', ['diff', '--name-only', range], {
    cwd,
    encoding: 'utf8',
  });
  if (diff.status !== 0) {
    throw new Error(
      `migration-canonical-freshness: git diff failed (${diff.stderr || diff.stdout || 'unknown'})`
    );
  }
  return diff.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function readRepoFile(root, relPath) {
  const full = path.join(root, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, 'utf8');
}