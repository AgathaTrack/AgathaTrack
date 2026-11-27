import { CARE_FAMILIES } from '../../lib/care/enums.js';
import {
  COMPLETION_MATRIX,
  completionEndpointFor,
  completionRequirementsFor,
  completionSpecFor,
  genericCompleteGuard,
  listCompletionFamilies,
} from '../../lib/care/completionRequirements.js';
import { WEIGHT_GENERIC_COMPLETE_ERROR } from '../../lib/care/observations/weightOccurrenceCompletion.js';

describe('completionRequirements registry (D-CIE-031)', () => {
  it('lists every canonical care family', () => {
    expect(listCompletionFamilies().sort()).toEqual([...CARE_FAMILIES].sort());
    for (const family of CARE_FAMILIES) {
      expect(completionSpecFor(family)).not.toBeNull();
    }
  });

  it('matrix keys match CARE_FAMILIES exactly', () => {
    expect(Object.keys(COMPLETION_MATRIX).sort()).toEqual([...CARE_FAMILIES].sort());
  });

  it('only weight_monitoring blocks generic complete', () => {
    for (const family of CARE_FAMILIES) {
      const blocked = genericCompleteGuard({ care_family: family });
      if (family === 'weight_monitoring') {
        expect(blocked).toBe(WEIGHT_GENERIC_COMPLETE_ERROR);
        expect(completionRequirementsFor(family)).toEqual(['weight']);
        expect(completionEndpointFor(family)).toBe('complete-weight');
      } else {
        expect(blocked).toBeNull();
        expect(completionRequirementsFor(family)).toEqual([]);
        expect(completionEndpointFor(family)).toBe('complete');
      }
    }
  });

  it('unknown family has no requirements and allows generic complete', () => {
    expect(completionRequirementsFor('unknown_family')).toEqual([]);
    expect(completionEndpointFor('unknown_family')).toBe('complete');
    expect(genericCompleteGuard({ care_family: 'unknown_family' })).toBeNull();
    expect(completionSpecFor('toString')).toBeNull();
  });
});