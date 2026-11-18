import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertValidAuditJson,
  collectHighCriticalGhsas,
  countHighCriticalMeta,
  evaluateFullTree,
  ghsaFromAdvisoryUrl,
  loadAllowlist,
  walkHighCritical,
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

test('assertValidAuditJson rejects error payloads', () => {
  assert.match(assertValidAuditJson({ error: 'lockfile corrupt' }, 'full'), /lockfile corrupt/);
  assert.match(assertValidAuditJson(null, 'full'), /empty/);
  assert.match(
    assertValidAuditJson({ metadata: {} }, 'full'),
    /missing metadata\.vulnerabilities/,
  );
  assert.equal(assertValidAuditJson({ metadata: { vulnerabilities: {} } }, 'full'), null);
});

test('metadata high without GHSA url implies unmapped findings', () => {
  const auditJson = {
    metadata: { vulnerabilities: { high: 2, critical: 0 } },
    vulnerabilities: {
      foo: {
        via: [{ severity: 'high', url: 'https://example.com/CVE-123', name: 'foo' }],
      },
    },
  };
  assert.equal(countHighCriticalMeta(auditJson), 2);
  assert.equal(collectHighCriticalGhsas(auditJson).size, 0);
});

test('unmapped high alongside an allowlisted GHSA is reported (fail closed)', () => {
  const auditJson = {
    metadata: { vulnerabilities: { high: 2, critical: 0 } },
    vulnerabilities: {
      picomatch: {
        via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf' }],
      },
      'mystery-pkg': {
        via: [{ severity: 'high', url: '' }],
      },
    },
  };
  const { ghsas, unmapped } = walkHighCritical(auditJson);
  assert.deepEqual([...ghsas], ['GHSA-FC5Q-39XC-VJPF']);
  assert.deepEqual([...unmapped], ['mystery-pkg']);
});

test('transitive high chain that reaches a GHSA is not reported as unmapped', () => {
  const auditJson = {
    metadata: { vulnerabilities: { high: 2, critical: 0 } },
    vulnerabilities: {
      jest: { via: ['jest-core'] },
      'jest-core': {
        via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf' }],
      },
    },
  };
  const { ghsas, unmapped } = walkHighCritical(auditJson);
  assert.deepEqual([...ghsas], ['GHSA-FC5Q-39XC-VJPF']);
  assert.equal(unmapped.size, 0);
});

test('zero metadata with an unmapped high in the vulnerabilities map is still reported', () => {
  const auditJson = {
    metadata: { vulnerabilities: { high: 0, critical: 0 } },
    vulnerabilities: {
      'mystery-pkg': {
        via: [{ severity: 'high', url: '' }],
      },
    },
  };
  const { ghsas, unmapped } = walkHighCritical(auditJson);
  assert.equal(ghsas.size, 0);
  assert.deepEqual([...unmapped], ['mystery-pkg']);
});
