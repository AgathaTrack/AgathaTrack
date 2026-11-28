import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pet_profile_app/features/care_item/care_item.dart';
import 'package:pet_profile_app/features/health_tracking/health_tracking.dart';

/// Wires §10.2 planned vet completion prompt into [CareCompletionFlow].
Override carePlannedVetPromptHookOverride() {
  return carePlannedVetPromptHookProvider.overrideWith(
    (ref) =>
        (
          BuildContext context,
          WidgetRef widgetRef,
          CarePlannedVetPromptContext data,
        ) {
          return HealthIssueLinkageFlow.maybePromptAfterPlannedVetCompletion(
            context,
            widgetRef,
            petId: data.petId,
            entryId: data.entryId,
            careSettingWire: data.careSettingWire,
            carePlanningWire: data.carePlanningWire,
            healthIssueId: data.healthIssueId,
            careFamily: data.careFamily,
            entryClassificationComplete: data.entryClassificationComplete,
          );
        },
  );
}
