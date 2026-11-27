/// Inputs that must have a value before an occurrence can be completed
/// (D-CIE-031). Only required inputs; today only weight monitoring.
///
/// Adding one later = one enum value here + one field widget + server
/// validation. The server stays the authority.
library;

const kWeightMonitoringFamily = 'weight_monitoring';

/// Canonical care families from [CARE_FAMILIES] on the server.
const kCareFamilies = <String>[
  'medication',
  'vaccination',
  'parasite_prevention',
  'wellness_review',
  'dental',
  'weight_monitoring',
  'grooming',
  'nail_care',
  'other',
];

enum CompletionRequirement { weight }

/// Which completion route the server expects (§18.6.2).
enum CompletionEndpoint { complete, completeWeight }

class FamilyCompletionSpec {
  const FamilyCompletionSpec({
    required this.requirements,
    required this.endpoint,
  });

  final List<CompletionRequirement> requirements;
  final CompletionEndpoint endpoint;
}

const _completionMatrix = <String, FamilyCompletionSpec>{
  'medication': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'vaccination': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'parasite_prevention': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'wellness_review': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'dental': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'weight_monitoring': FamilyCompletionSpec(
    requirements: [CompletionRequirement.weight],
    endpoint: CompletionEndpoint.completeWeight,
  ),
  'grooming': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'nail_care': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
  'other': FamilyCompletionSpec(
    requirements: [],
    endpoint: CompletionEndpoint.complete,
  ),
};

FamilyCompletionSpec? completionSpecFor(String? careFamily) {
  if (careFamily == null) return null;
  return _completionMatrix[careFamily];
}

List<CompletionRequirement> completionRequirementsFor(String? careFamily) {
  return completionSpecFor(careFamily)?.requirements ??
      const <CompletionRequirement>[];
}

CompletionEndpoint completionEndpointFor(String? careFamily) {
  return completionSpecFor(careFamily)?.endpoint ?? CompletionEndpoint.complete;
}

/// Values entered for the requirements.
class CompletionInputs {
  const CompletionInputs({this.weightValue, this.weightUnit = 'kg'});

  final double? weightValue;
  final String weightUnit;
}

/// Requirements of [careFamily] that [inputs] does not satisfy yet.
List<CompletionRequirement> missingRequirements(
  String? careFamily,
  CompletionInputs inputs,
) {
  return completionRequirementsFor(careFamily)
      .where((requirement) {
        switch (requirement) {
          case CompletionRequirement.weight:
            final value = inputs.weightValue;
            return value == null || !value.isFinite || value <= 0;
        }
      })
      .toList(growable: false);
}
