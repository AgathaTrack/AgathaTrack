#!/usr/bin/env node
/**
 * Blocking npm audit gate: production deps must be clean; dev tree may ignore
 * owner-approved GHSA ids in scripts/npm-audit-allowlist.json until they expire.
 *
 * Usage: node scripts/npm_audit_gate.js --package server|e2e
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST = path.join(REPO_ROOT, 'scripts', 'npm-audit-allowlist.json');
const MS_PER_DAY = 86_400_000;

const SEVERITIES = new Set(['high', 'critical']);

export function ghsaFromAdvisoryUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  return m ? m[0].toUpperCase() : null;
}

export function collectHighCriticalGhsas(auditJson) {
  const ghsas = new Set();
  const vulns = auditJson.vulnerabilities ?? {};

  function walkVia(name, seen = new Set()) {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = vulns[name];
    if (!entry) return;
    for (const via of entry.via ?? []) {
      if (typeof via === 'string') {
        walkVia(via, seen);
      } else if (via && typeof via === 'object') {
        if (SEVERITIES.has(via.severity)) {
          const id = ghsaFromAdvisoryUrl(via.url);
          if (id) ghsas.add(id);
        }
      }
    }
  }

  for (const name of Object.keys(vulns)) {
    walkVia(name);
  }
  return ghsas;
}

export function countHighCriticalMeta(auditJson) {
  const m = auditJson.metadata?.vulnerabilities ?? {};
  return (m.high ?? 0) + (m.critical ?? 0);
}

export function loadAllowlist(allowlistPath, pkgName, now = new Date()) {
  const raw = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  const entries = raw.entries ?? [];
  const applicable = entries.filter(
    (e) => !e.packages?.length || e.packages.includes(pkgName),
  );
  const active = [];
  const expired = [];
  const expiringSoon = [];

  for (const entry of applicable) {
    const exp = new Date(entry.expires);
    if (Number.isNaN(exp.getTime())) {
      throw new Error(`Invalid expires on allowlist entry ${entry.ghsa}`);
    }
    if (exp < now) {
      expired.push(entry);
    } else {
      active.push(entry);
      const days = (exp - now) / MS_PER_DAY;
      if (days <= 7) expiringSoon.push({ entry, days });
    }
  }
  return { active, expired, expiringSoon, allEntries: entries };
}

export function evaluateFullTree(ghsas, allowlistState) {
  const allowed = new Set(allowlistState.active.map((e) => e.ghsa.toUpperCase()));
  const unallowed = [...ghsas].filter((g) => !allowed.has(g));
  const stale = allowlistState.active.filter((e) => !ghsas.has(e.ghsa.toUpperCase()));
  const expiredStillPresent = allowlistState.expired.filter((e) =>
    ghsas.has(e.ghsa.toUpperCase()),
  );
  return { unallowed, stale, expiredStillPresent };
}

function runNpmAuditJson(packageDir, { omitDev }) {
  const args = ['audit', '--json', '--audit-level=high'];
  if (omitDev) args.push('--omit=dev');
  const result = spawnSync('npm', args, {
    cwd: packageDir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  let auditJson = null;
  if (result.stdout?.trim()) {
    try {
      auditJson = JSON.parse(result.stdout);
    } catch {
      // fall through
    }
  }
  return { result, auditJson };
}

function usage() {
  console.error('Usage: node scripts/npm_audit_gate.js --package server|e2e [--allowlist <path>]');
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  let pkg = null;
  let allowlistPath = DEFAULT_ALLOWLIST;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--package' && argv[i + 1]) {
      pkg = argv[++i];
    } else if (argv[i] === '--allowlist' && argv[i + 1]) {
      allowlistPath = path.resolve(argv[++i]);
    } else {
      usage();
    }
  }
  if (!pkg || !['server', 'e2e'].includes(pkg)) usage();

  const packageDir = path.join(REPO_ROOT, pkg);
  const now = new Date();

  const prod = runNpmAuditJson(packageDir, { omitDev: true });
  if (!prod.auditJson) {
    console.error(`npm audit (production) failed to run in ${pkg}:`, prod.result.stderr || prod.result.stdout);
    process.exit(1);
  }
  const prodHigh = countHighCriticalMeta(prod.auditJson);
  if (prodHigh > 0) {
    console.error(
      `npm audit gate: ${pkg} production dependencies have ${prodHigh} high/critical finding(s); allowlist does not apply to prod tree.`,
    );
    process.exit(1);
  }

  const full = runNpmAuditJson(packageDir, { omitDev: false });
  if (!full.auditJson) {
    console.error(`npm audit (full) failed to run in ${pkg}:`, full.result.stderr || full.result.stdout);
    process.exit(1);
  }
  const ghsas = collectHighCriticalGhsas(full.auditJson);
  const fullHighMeta = countHighCriticalMeta(full.auditJson);
  if (ghsas.size === 0) {
    if (fullHighMeta > 0) {
      console.error(
        `npm audit gate: ${pkg} reports ${fullHighMeta} high/critical finding(s) but no parseable GHSA ids; fail closed.`,
      );
      process.exit(1);
    }
    console.log(`npm audit gate: ${pkg} ok (production clean; no high/critical in full tree).`);
    process.exit(0);
  }

  let allowlistState;
  try {
    allowlistState = loadAllowlist(allowlistPath, pkg, now);
  } catch (err) {
    console.error('npm audit gate: allowlist error:', err.message);
    process.exit(1);
  }

  if (allowlistState.expired.length) {
    for (const entry of allowlistState.expired) {
      console.error(
        `npm audit gate: allowlist entry ${entry.ghsa} expired ${entry.expires}; remove after fix lands or renew with owner approval.`,
      );
    }
    process.exit(1);
  }

  const { unallowed, stale, expiredStillPresent } = evaluateFullTree(ghsas, allowlistState);

  if (expiredStillPresent.length) {
    for (const entry of expiredStillPresent) {
      console.error(`npm audit gate: expired allowlist still needed for ${entry.ghsa}`);
    }
    process.exit(1);
  }

  if (unallowed.length) {
    console.error(
      `npm audit gate: ${pkg} has unallowed high/critical advisories: ${unallowed.join(', ')}`,
    );
    process.exit(1);
  }

  for (const entry of allowlistState.expiringSoon) {
    console.warn(
      `npm audit gate: allowlist ${entry.entry.ghsa} expires in ${Math.ceil(entry.days)} day(s) (${entry.entry.expires}).`,
    );
  }
  for (const entry of stale) {
    console.warn(
      `npm audit gate: allowlist ${entry.ghsa} no longer appears in audit output; remove entry when confirmed fixed.`,
    );
  }

  const tolerated = [...ghsas].sort().join(', ');
  console.log(`npm audit gate: ${pkg} ok (production clean; tolerated dev-only: ${tolerated}).`);
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}