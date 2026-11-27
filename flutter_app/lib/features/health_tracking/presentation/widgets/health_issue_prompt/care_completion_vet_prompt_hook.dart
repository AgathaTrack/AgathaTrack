import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:pet_profile_app/features/care_item/care_item.dart';
import 'package:pet_profile_app/features/care_taxonomy/care_taxonomy.dart';
import 'health_issue_linkage_flow.dart';

/// Optional `CareCompletionFlow.done` success hook: taxonomy §10.2 planned vet prompt.
Future<void> careCompletionPlannedVetPromptAfterDone(
  BuildContext context,
  WidgetRef ref,
  CareItemSchedule schedule,
  CareCommandResult result, {
  String? careSettingWire,
  String? carePlanningWire,
  String? healthIssueId,
}) async {
  final setting = CareSettingWire.fromWire(
    careSettingWire ?? result.careSettingWire,
  );
  final planning = CarePlanningModeWire.fromWire(
    carePlanningWire ?? result.carePlanningWire,
  );
  if (setting == null || planning == null) return;

  await HealthIssueLinkageFlow.maybePromptAfterPlannedVetCompletion(
    context,
    ref,
    petId: schedule.petId,
    entryId: schedule.entryId,
    careSetting: setting,
    carePlanning: planning,
    healthIssueId: healthIssueId ?? result.healthIssueId,
    careFamily: schedule.careFamily,
  );
}
