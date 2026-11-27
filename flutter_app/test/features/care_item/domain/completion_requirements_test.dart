import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/care_item/care_item.dart';

void main() {
  group('completion requirements (D-CIE-031)', () {
    test('weight monitoring requires a weight and uses complete-weight', () {
      expect(completionRequirementsFor('weight_monitoring'), [
        CompletionRequirement.weight,
      ]);
      expect(
        completionEndpointFor('weight_monitoring'),
        CompletionEndpoint.completeWeight,
      );
    });

    test('every taxonomy family except weight has no requirement and uses complete',
        () {
      for (final family in kCareFamilies) {
        if (family == kWeightMonitoringFamily) continue;
        expect(completionRequirementsFor(family), isEmpty);
        expect(completionEndpointFor(family), CompletionEndpoint.complete);
      }
      expect(completionRequirementsFor(null), isEmpty);
      expect(completionEndpointFor(null), CompletionEndpoint.complete);
    });

    test('a weight must be a finite value above 0', () {
      const family = 'weight_monitoring';
      expect(missingRequirements(family, const CompletionInputs()), [
        CompletionRequirement.weight,
      ]);
      expect(
        missingRequirements(family, const CompletionInputs(weightValue: 0)),
        isNotEmpty,
      );
      expect(
        missingRequirements(family, const CompletionInputs(weightValue: -1)),
        isNotEmpty,
      );
      expect(
        missingRequirements(
          family,
          const CompletionInputs(weightValue: double.nan),
        ),
        isNotEmpty,
      );
      expect(
        missingRequirements(family, const CompletionInputs(weightValue: 12.4)),
        isEmpty,
      );
      expect(
        missingRequirements('medication', const CompletionInputs()),
        isEmpty,
      );
    });
  });
}
