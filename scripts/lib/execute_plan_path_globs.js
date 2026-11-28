'use strict';

/**
 * Planned-path gate for execute-plan approve (run D, T1).
 * Moved verbatim from `scripts/lib/pipeline_path_gate.js`. The old module keeps its export until T3.
 */

const { isForbiddenPath } = require('../../.github/scripts/agent-safety-lib');
const { globToRegExp } = require('./execute_plan_schema');

const PROTECTED_GLOBS = ['.github/**', '.cursor/agent-kernel/**'];

/** Sample paths used to detect globs that could hit protected or forbidden areas. */
const PATH_GATE_SAMPLES = [
  '.github/workflows/evil.yml',
  '.github/workflows/evil.yaml',
  '.github/scripts/hack.js',
  '.cursor/agent-kernel/ROUTER.md',
  'server/config/security.js',
  'db/migrations/001_evil.sql',
  'infra/x',
  'flutter_app/lib/foo.dart',
  'docs/x.md',
];

/**
 * @param {string[]} globs
 * @param {string[]} trackedFiles
 * @returns {{ ok: true, expanded: string[] } | { ok: false, reason: string, forbiddenHits?: string[], protectedHits?: string[], unmatchedGlobs?: string[] }}
 */
function evaluatePlannedPathGlobs(globs, trackedFiles) {
  if (!globs?.length) {
    return { ok: false, reason: 'missing-agent-paths' };
  }

  const forbiddenHits = [];
  const protectedHits = [];
  const unmatchedGlobs = [];

  for (const glob of globs) {
    let globMatchedSample = false;
    for (const sample of PATH_GATE_SAMPLES) {
      if (globToRegExp(glob).test(sample)) {
        globMatchedSample = true;
        if (isForbiddenPath(sample)) {
          forbiddenHits.push(`glob:${glob}→${sample}`);
        }
        for (const prot of PROTECTED_GLOBS) {
          if (globToRegExp(prot).test(sample)) {
            protectedHits.push(`glob:${glob}→${sample}`);
          }
        }
      }
    }
    const literalPrefix = String(glob).replace(/\*+$/, '').replace(/\/$/, '');
    for (const prot of PROTECTED_GLOBS) {
      const protRoot = prot.replace(/\/\*\*$/, '');
      if (literalPrefix.startsWith(`${protRoot}/`) || literalPrefix === protRoot) {
        globMatchedSample = true;
        protectedHits.push(`glob:${glob}`);
      }
    }
    if (isForbiddenPath(literalPrefix)) {
      globMatchedSample = true;
      forbiddenHits.push(`glob:${glob}`);
    }
    const expandedForGlob = trackedFiles.filter((file) => globToRegExp(glob).test(file));
    if (expandedForGlob.length === 0 && !globMatchedSample) {
      unmatchedGlobs.push(glob);
    }
    for (const file of expandedForGlob) {
      if (isForbiddenPath(file)) {
        forbiddenHits.push(file);
      }
      for (const prot of PROTECTED_GLOBS) {
        if (globToRegExp(prot).test(file)) {
          protectedHits.push(file);
        }
      }
    }
  }

  if (forbiddenHits.length > 0 || protectedHits.length > 0) {
    return {
      ok: false,
      reason: 'sensitive-paths',
      forbiddenHits,
      protectedHits,
    };
  }

  const expanded = new Set();
  for (const file of trackedFiles) {
    for (const glob of globs) {
      if (globToRegExp(glob).test(file)) {
        expanded.add(file);
      }
    }
  }

  if (unmatchedGlobs.length > 0) {
    return {
      ok: false,
      reason: 'unmatched-globs',
      unmatchedGlobs,
      expanded: [...expanded],
    };
  }

  return { ok: true, expanded: [...expanded] };
}

function validateAutoSkipGlobs(globs) {
  const problems = [];
  if (!Array.isArray(globs) || globs.length === 0) {
    return problems;
  }
  for (const glob of globs) {
    for (const sample of PATH_GATE_SAMPLES) {
      if (globToRegExp(glob).test(sample)) {
        if (isForbiddenPath(sample)) {
          problems.push(`aat.autoSkip glob ${glob} must not match forbidden path ${sample}`);
        }
        for (const prot of PROTECTED_GLOBS) {
          if (globToRegExp(prot).test(sample)) {
            problems.push(`aat.autoSkip glob ${glob} must not match protected path ${sample}`);
          }
        }
      }
    }
    const literalPrefix = String(glob).replace(/\*+$/, '').replace(/\/$/, '');
    for (const prot of PROTECTED_GLOBS) {
      const protRoot = prot.replace(/\/\*\*$/, '');
      if (literalPrefix.startsWith(`${protRoot}/`) || literalPrefix === protRoot) {
        problems.push(`aat.autoSkip glob ${glob} must not cover ${prot}`);
      }
    }
    if (isForbiddenPath(literalPrefix)) {
      problems.push(`aat.autoSkip glob ${glob} must not cover forbidden prefix ${literalPrefix}`);
    }
  }
  return problems;
}

module.exports = {
  PROTECTED_GLOBS,
  PATH_GATE_SAMPLES,
  evaluatePlannedPathGlobs,
  validateAutoSkipGlobs,
};
