import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectHighCriticalGhsas,
  countHighCriticalMeta,
  evaluateFullTree,
  ghsaFromAdvisoryUrl,
  loadAllowlist,
} from '../npm_audit_gate.js';

test('ghsaFromAdvisoryUrl extracts advisory id', () => {
  assert.equal(
    ghsaFromAdvisoryUrl('https://github.com/advisories/GHSA-fc5q-39xc-vjpf'),
    'GHSA-FC5Q-39XC-VJPF',
  );
});

test('collectHighCriticalGhsas dedupes transitive highs', () => {
  const auditJson = {
    vulnerabilities: {
      picomatch: {
        via: [
          {
            source: 1,
            name: 'picomatch',
            severity: 'high',
            url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
          },
        ],
      },
      'jest-util': {
        via: ['picomatch'],
      },
    },
  };
  const ghsas = collectHighCriticalGhsas(auditJson);
  assert.deepEqual([...ghsas], ['GHSA-FC5Q-39XC-VJPF']);
});

const ALLOWLIST_PATH = fileURLToPath(new URL('../npm-audit-allowlist.json', import.meta.url));

test('loadAllowlist splits active and expired by package', () => {
  const state = loadAllowlist(ALLOWLIST_PATH, 'server', new Date('2026-11-18T12:00:00Z'));
  assert.equal(state.active.length, 1);
  assert.equal(state.expired.length, 0);

  const afterExpiry = loadAllowlist(ALLOWLIST_PATH, 'server', new Date('2026-12-19T00:00:00Z'));
  assert.equal(afterExpiry.active.length, 0);
  assert.equal(afterExpiry.expired.length, 1);
});

test('evaluateFullTree flags unallowed GHSA', () => {
  const ghsas = new Set(['GHSA-FC5Q-39XC-VJPF', 'GHSA-AAAA-BBBB-CCCC']);
  const allow = {
    active: [{ ghsa: 'GHSA-fc5q-39xc-vjpf', expires: '2026-12-18' }],
    expired: [],
  };
  const { unallowed, stale } = evaluateFullTree(ghsas, allow);
  assert.deepEqual(unallowed, ['GHSA-AAAA-BBBB-CCCC']);
  assert.equal(stale.length, 0);
});

test('countHighCriticalMeta sums high and critical', () => {
  assert.equal(
    countHighCriticalMeta({
      metadata: { vulnerabilities: { high: 3, critical: 1 } },
    }),
    4,
  );
});