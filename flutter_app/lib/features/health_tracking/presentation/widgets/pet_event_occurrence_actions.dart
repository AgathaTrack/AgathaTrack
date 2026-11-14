import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../l10n/app_localizations.dart';
import '../../domain/entities/health_entry.dart';
import '../../domain/entities/health_occurrence.dart';
import '../controllers/care_schedule_controller.dart';
import '../providers/care_item_detail_refresh.dart';
import 'care_schedule_command_feedback.dart';
import 'reschedule_occurrence_flow.dart';

/// Occurrence mutations from the event-view workbench.
class PetEventOccurrenceActions {
  const PetEventOccurrenceActions._();

  static void invalidateOccurrenceData(
    WidgetRef ref,
    String entryId, {
    String? absenceId,
  }) {
    invalidateCareItemDetailData(ref, entryId);
  }

  static Future<void> changeDate(
    BuildContext context,
    WidgetRef ref,
    HealthEntry entry,
    HealthOccurrence occurrence, {
    DateTime? initialDate,
    String? reasonCode,
  }) {
    return RescheduleOccurrenceFlow.openSheetAndReschedule(
      context: context,
      ref: ref,
      entry: entry,
      occurrence: occurrence,
      initialDate: initialDate,
      reasonCode: reasonCode,
    );
  }

  static Future<void> skip(
    BuildContext context,
    WidgetRef ref,
    HealthEntry entry,
    HealthOccurrence occurrence, {
    String? absenceId,
  }) async {
    try {
      final outcome = await ref
          .read(careScheduleControllerProvider)
          .skipOccurrence(entry.id, occurrence.id, absenceId: absenceId);
      if (!context.mounted) return;
      final l = AppLocalizations.of(context)!;
      showCareScheduleCommandSnackBar(
        context,
        outcome: outcome,
        successMessage: l.occurrenceSkipped,
      );
      if (outcome == null) return;
    } catch (_) {
      if (!context.mounted) return;
      final l = AppLocalizations.of(context)!;
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l.careCompletionFailed)));
      return;
    }
  }
}
