/**
 * Completion requirement registry per care family (D-CIE-031).
 * @see docs/domains/pet_care/features/care-item-evolution.md — Completion requirements
 */

import { CARE_FAMILIES } from './enums.js';
import { WEIGHT_GENERIC_COMPLETE_ERROR } from './observations/weightOccurrenceCompletion.js';

/** @typedef {'weight'} CompletionRequirementKind */

/**
 * @typedef {object} FamilyCompletionSpec
 * @property {readonly CompletionRequirementKind[]} requirements
 * @property {'complete' | 'complete-weight'} endpoint
 * @property {string | null} genericCompleteError
 */

/** @type {Record<string, FamilyCompletionSpec>} */
const COMPLETION_MATRIX = {
  medication: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  vaccination: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  parasite_prevention: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  wellness_review: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  dental: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  weight_monitoring: {
    requirements: ['weight'],
    endpoint: 'complete-weight',
    genericCompleteError: WEIGHT_GENERIC_COMPLETE_ERROR,
  },
  grooming: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  nail_care: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
  other: {
    requirements: [],
    endpoint: 'complete',
    genericCompleteError: null,
  },
};

/**
 * @param {string | null | undefined} careFamily
 * @returns {readonly CompletionRequirementKind[]}
 */
export function completionRequirementsFor(careFamily) {
  if (!careFamily) return [];
  return COMPLETION_MATRIX[careFamily]?.requirements ?? [];
}

/**
 * @param {string | null | undefined} careFamily
 * @returns {'complete' | 'complete-weight'}
 */
export function completionEndpointFor(careFamily) {
  if (!careFamily) return 'complete';
  return COMPLETION_MATRIX[careFamily]?.endpoint ?? 'complete';
}

/**
 * Guard for routes that must not complete weight_monitoring without an observation.
 * @param {{ care_family?: string | null }} entry
 * @returns {string | null} Error message for HTTP 400, or null when allowed.
 */
export function genericCompleteGuard(entry) {
  const family = entry?.care_family;
  if (!family) return null;
  return COMPLETION_MATRIX[family]?.genericCompleteError ?? null;
}

/** @returns {string[]} */
export function listCompletionFamilies() {
  return [...CARE_FAMILIES];
}

/**
 * @param {string} careFamily
 * @returns {FamilyCompletionSpec | null}
 */
export function completionSpecFor(careFamily) {
  return COMPLETION_MATRIX[careFamily] ?? null;
}

export { COMPLETION_MATRIX };