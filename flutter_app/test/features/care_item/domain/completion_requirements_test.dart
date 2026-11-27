import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/care_item/care_item.dart';

void main() {
  group('completion requirements (D-CIE-031)', () {
    test('registry lists all nine care families', () {
      expect(kCareFamilies.length, 9);
      for (final family in kCareFamilies) {
        expect(completionSpecFor(family), isNotNull);
      }
    });

    test('weight monitoring requires a weight and uses complete-weight', () {
      expect(completionRequirementsFor('weight_monitoring'), [
        CompletionRequirement.weight,
      ]);
      expect(
        completionEndpointFor('weight_monitoring'),
        CompletionEndpoint.completeWeight,
      );
    });

    test('every other canonical family has no requirement and uses complete', () {
      for (final family in kCareFamilies) {
        if (family == 'weight_monitoring') continue;
        expect(completionRequirementsFor(family), isEmpty, reason: family);
        expect(
          completionEndpointFor(family),
          CompletionEndpoint.complete,
          reason: family,
        );
      }
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