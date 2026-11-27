/**
 * Per-family occurrence completion requirements (D-CIE-031).
 * @see docs/domains/pet_care/features/care-item-evolution.md
 */

import { CARE_FAMILIES } from './enums.js';
import { WEIGHT_GENERIC_COMPLETE_ERROR } from './observations/weightOccurrenceCompletion.js';

export const COMPLETION_ENDPOINT_COMPLETE = 'complete';
export const COMPLETION_ENDPOINT_COMPLETE_WEIGHT = 'complete-weight';

/** @typedef {'weight'} CompletionRequirementKind */

/**
 * @typedef {object} CompletionRequirementRow
 * @property {readonly CompletionRequirementKind[]} requirements
 * @property {string} endpoint
 * @property {string | null} genericCompleteError
 */

/** @type {Map<string, CompletionRequirementRow>} */
const REGISTRY = new Map(
  [...CARE_FAMILIES].map((family) => [
    family,
    {
      requirements: [],
      endpoint: COMPLETION_ENDPOINT_COMPLETE,
      genericCompleteError: null,
    },
  ]),
);

REGISTRY.set('weight_monitoring', {
  requirements: ['weight'],
  endpoint: COMPLETION_ENDPOINT_COMPLETE_WEIGHT,
  genericCompleteError: WEIGHT_GENERIC_COMPLETE_ERROR,
});

/**
 * @param {string | null | undefined} careFamily
 * @returns {CompletionRequirementRow}
 */
export function completionRequirementsForFamily(careFamily) {
  if (careFamily && REGISTRY.has(careFamily)) {
    return REGISTRY.get(careFamily);
  }
  return {
    requirements: [],
    endpoint: COMPLETION_ENDPOINT_COMPLETE,
    genericCompleteError: null,
  };
}

/** Error message when generic `…/complete` is used but the family requires another route. */
export function genericCompleteGuard(entry) {
  return completionRequirementsForFamily(entry?.care_family).genericCompleteError;
}

/** Every taxonomy family with requirement + endpoint (tests + docs parity). */
export function listCompletionRequirementRegistry() {
  return [...CARE_FAMILIES].map((careFamily) => ({
    careFamily,
    ...completionRequirementsForFamily(careFamily),
  }));
}