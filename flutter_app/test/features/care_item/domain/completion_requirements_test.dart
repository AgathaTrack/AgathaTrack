import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/care_item/care_item.dart';
import 'package:pet_profile_app/features/care_taxonomy/domain/care_family.dart';

void main() {
  group('completion requirements (D-CIE-031)', () {
    test('registry keys match CareFamily wire values', () {
      final wireFamilies = CareFamily.values.map((f) => f.wireValue).toList();
      expect(kCareFamilies, containsAll(wireFamilies));
      expect(kCareFamilies.length, wireFamilies.length);
      for (final wire in wireFamilies) {
        expect(completionSpecFor(wire), isNotNull);
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

    test(
      'every other canonical family has no requirement and uses complete',
      () {
        for (final family in kCareFamilies) {
          if (family == 'weight_monitoring') continue;
          expect(completionRequirementsFor(family), isEmpty, reason: family);
          expect(
            completionEndpointFor(family),
            CompletionEndpoint.complete,
            reason: family,
          );
        }
      },
    );

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
