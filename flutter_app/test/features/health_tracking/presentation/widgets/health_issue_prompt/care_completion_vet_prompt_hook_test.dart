import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/care_item/application/care_command_outcome.dart';
import 'package:pet_profile_app/features/care_taxonomy/care_taxonomy.dart';
import 'package:pet_profile_app/features/health_tracking/presentation/widgets/health_issue_prompt/health_issue_prompt_eligibility.dart';

void main() {
  test('linked health_issue_id from completion response suppresses prompt', () {
    const result = CareCommandResult(
      entryId: 'e1',
      careSettingWire: 'vet',
      carePlanningWire: 'planned',
      healthIssueId: 'issue-1',
    );
    const hintId = 'stale';
    final issueId = result.healthIssueId ?? hintId;
    expect(
      shouldPromptPlannedVetCompletion(
        careSetting: CareSettingWire.fromWire(result.careSettingWire)!,
        carePlanning: CarePlanningModeWire.fromWire(result.carePlanningWire)!,
        healthIssueId: issueId,
      ),
      isFalse,
    );
  });
}