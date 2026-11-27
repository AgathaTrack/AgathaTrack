import { describe, expect, it } from '@jest/globals';

import { CARE_FAMILIES } from '../../lib/care/enums.js';
import {
  COMPLETION_ENDPOINT_COMPLETE,
  COMPLETION_ENDPOINT_COMPLETE_WEIGHT,
  completionRequirementsForFamily,
  genericCompleteGuard,
  listCompletionRequirementRegistry,
} from '../../lib/care/completionRequirements.js';
import { WEIGHT_GENERIC_COMPLETE_ERROR } from '../../lib/care/observations/weightOccurrenceCompletion.js';

describe('completionRequirements registry (D-CIE-031)', () => {
  it('lists every CARE_FAMILIES value', () => {
    const rows = listCompletionRequirementRegistry();
    expect(rows.map((row) => row.careFamily).sort()).toEqual([...CARE_FAMILIES].sort());
  });

  it('weight_monitoring requires weight and blocks generic complete', () => {
    const row = completionRequirementsForFamily('weight_monitoring');
    expect(row.requirements).toEqual(['weight']);
    expect(row.endpoint).toBe(COMPLETION_ENDPOINT_COMPLETE_WEIGHT);
    expect(row.genericCompleteError).toBe(WEIGHT_GENERIC_COMPLETE_ERROR);
    expect(genericCompleteGuard({ care_family: 'weight_monitoring' })).toBe(
      WEIGHT_GENERIC_COMPLETE_ERROR,
    );
  });

  it('other taxonomy families use generic complete with no extra requirements', () => {
    for (const family of CARE_FAMILIES) {
      if (family === 'weight_monitoring') continue;
      const row = completionRequirementsForFamily(family);
      expect(row.requirements).toEqual([]);
      expect(row.endpoint).toBe(COMPLETION_ENDPOINT_COMPLETE);
      expect(row.genericCompleteError).toBeNull();
      expect(genericCompleteGuard({ care_family: family })).toBeNull();
    }
  });

  it('unknown or null care_family allows generic complete', () => {
    expect(completionRequirementsForFamily(null).endpoint).toBe(COMPLETION_ENDPOINT_COMPLETE);
    expect(genericCompleteGuard({ care_family: null })).toBeNull();
    expect(genericCompleteGuard({})).toBeNull();
  });
});