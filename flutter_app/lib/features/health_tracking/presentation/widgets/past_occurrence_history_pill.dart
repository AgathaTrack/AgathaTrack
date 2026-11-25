import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../core/theme/app_color_tokens.dart';
import '../../../../core/utils/care_instant_format.dart';
import '../../../../core/weight/weight_unit.dart';
import '../../../../core/weight/weight_unit_preference.dart';
import '../../../../l10n/app_localizations.dart';
import '../../domain/entities/health_occurrence.dart';
import 'health_entry_status.dart';
import 'past_occurrence_history_utils.dart';

/// One-line History pill (inline module + full-history pop-up).
class PastOccurrenceHistoryPill extends ConsumerWidget {
  const PastOccurrenceHistoryPill({
    super.key,
    required this.occurrence,
    required this.muted,
    this.onTap,
  });

  final HealthOccurrence occurrence;
  final bool muted;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l = AppLocalizations.of(context)!;
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    final dueLine = formatCareDueInstant(
      scheduledDate: occurrence.scheduledDate,
      scheduledTime: occurrence.scheduledTime,
      dateOnly: (d) => d,
      dateAtTime: (d, t) => l.occurrenceDateAtTime(d, t),
    );

    final isNotRecorded = occurrenceIsNotRecorded(occurrence);
    final isSkipped = occurrenceIsSkipped(occurrence);
    final isDone = occurrenceIsDone(occurrence);

    String leadingLine = dueLine;
    if (isDone && occurrence.linkedWeight != null) {
      final displayUnit = ref.watch(weightUnitPreferenceProvider);
      final weightText = formatWeight(
        occurrence.linkedWeight!.valueKg,
        displayUnit,
      );
      leadingLine = '$dueLine · $weightText';
    }

    final IconData icon;
    final Color iconColor;
    String? a11yCloseDate;
    String? visibleCloseDate;
    String semanticsLabel;

    if (isNotRecorded) {
      icon = Icons.help_outline;
      iconColor = colorScheme.onSurfaceVariant;
      semanticsLabel = l.historyPillA11yNotRecorded(dueLine);
    } else if (isSkipped) {
      icon = Icons.skip_next;
      iconColor = colorScheme.onSurfaceVariant;
      final recorded = occurrence.markedAt;
      final closeInstant = recorded != null
          ? (recorded.isUtc ? recorded.toLocal() : recorded)
          : occurrence.completedOn;
      if (closeInstant != null) {
        a11yCloseDate = recorded != null
            ? formatCareRecordedCalendarDate(closeInstant)
            : formatHealthEntryStatusDate(closeInstant);
        if (pastOccurrenceCloseDayDiffersFromDue(occurrence, closeInstant)) {
          visibleCloseDate = a11yCloseDate;
        }
      }
      semanticsLabel = a11yCloseDate != null
          ? l.historyPillA11ySkipped(dueLine, a11yCloseDate)
          : l.historyPillA11yNotRecorded(dueLine);
    } else if (isDone) {
      icon = Icons.check_circle;
      iconColor = AppColorTokens.success;
      final completed = occurrence.completedOn;
      if (completed != null) {
        a11yCloseDate = formatHealthEntryStatusDate(completed);
        if (pastOccurrenceCloseDayDiffersFromDue(occurrence, completed)) {
          visibleCloseDate = a11yCloseDate;
        }
      }
      final weight = occurrence.linkedWeight;
      if (weight != null && a11yCloseDate != null) {
        final displayUnit = ref.watch(weightUnitPreferenceProvider);
        final weightText = formatWeight(weight.valueKg, displayUnit);
        semanticsLabel = l.historyPillA11yDoneWithWeight(
          dueLine,
          a11yCloseDate,
          weightText,
        );
      } else if (a11yCloseDate != null) {
        semanticsLabel = l.historyPillA11yDone(dueLine, a11yCloseDate);
      } else {
        semanticsLabel = dueLine;
      }
    } else {
      icon = Icons.help_outline;
      iconColor = colorScheme.onSurfaceVariant;
      semanticsLabel = dueLine;
    }

    final line = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(
            leadingLine,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: muted ? colorScheme.onSurfaceVariant : null,
            ),
          ),
        ),
        Text(
          ' – ',
          style: theme.textTheme.bodyMedium?.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        Icon(icon, size: 18, color: iconColor),
        if (visibleCloseDate != null)
          Text(
            ' $visibleCloseDate',
            style: theme.textTheme.bodyMedium?.copyWith(
              color: muted ? colorScheme.onSurfaceVariant : null,
            ),
          ),
      ],
    );

    final card = Card(
      key: Key('pet_event_past_occurrence_${occurrence.id}'),
      margin: const EdgeInsets.only(bottom: 8),
      elevation: 0,
      color: colorScheme.surfaceContainerHighest.withValues(
        alpha: muted ? 0.5 : 1,
      ),
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: onTap != null ? 48 : 0),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Align(alignment: Alignment.centerLeft, child: line),
        ),
      ),
    );

    final body = Semantics(
      container: true,
      button: onTap != null,
      label: semanticsLabel,
      excludeSemantics: true,
      child: card,
    );

    if (onTap == null) return body;
    return InkWell(onTap: onTap, child: body);
  }
}
