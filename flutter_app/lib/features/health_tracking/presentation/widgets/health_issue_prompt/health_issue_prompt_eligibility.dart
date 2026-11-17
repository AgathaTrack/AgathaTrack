import '../../../../care_taxonomy/care_taxonomy.dart';

/// Whether to show the §10.1 unplanned vet save health-issue prompt.
bool shouldPromptUnplannedVetSave({
  required CareSetting careSetting,
  required CarePlanningMode carePlanning,
  String? healthIssueId,
}) {
  return careSetting == CareSetting.vet &&
      carePlanning == CarePlanningMode.unplanned &&
      healthIssueId == null;
}
