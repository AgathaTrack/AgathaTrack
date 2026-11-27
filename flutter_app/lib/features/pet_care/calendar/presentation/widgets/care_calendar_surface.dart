import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:pet_profile_app/l10n/app_localizations.dart';
import '../../domain/care_calendar_overlay_days.dart';
import '../../domain/entities/care_calendar.dart';
import 'care_calendar_before_month_strip.dart';
import 'care_calendar_month_grid.dart';

class CareCalendarSurface extends StatelessWidget {
  const CareCalendarSurface({
    super.key,
    required this.petId,
    required this.month,
    required this.result,
    required this.onPreviousMonth,
    required this.onNextMonth,
  });

  final String petId;
  final DateTime month;
  final CareCalendarResult result;
  final VoidCallback onPreviousMonth;
  final VoidCallback onNextMonth;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final monthLabel = DateFormat.yMMMM().format(month);
    final itemsByDate = {for (final day in result.days) day.date: day.items};
    final overlayByDay = plannedAbsenceOverlaysByDay(
      result.plannedAbsenceOverlays,
    );
    final hasAny =
        result.days.any((d) => d.items.isNotEmpty) || overlayByDay.isNotEmpty;

    return Semantics(
      container: true,
      label: l.careCalendarSemanticsLabel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Semantics(
                button: true,
                identifier: 'care_calendar_prev_month',
                child: IconButton(
                  key: const Key('care_calendar_prev_month'),
                  onPressed: onPreviousMonth,
                  icon: const Icon(Icons.chevron_left),
                ),
              ),
              Expanded(
                child: Semantics(
                  header: true,
                  identifier: 'care_calendar_month_label',
                  child: Text(
                    monthLabel,
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
              ),
              Semantics(
                button: true,
                identifier: 'care_calendar_next_month',
                child: IconButton(
                  key: const Key('care_calendar_next_month'),
                  onPressed: onNextMonth,
                  icon: const Icon(Icons.chevron_right),
                ),
              ),
            ],
          ),
          if (result.beforeMonthItems.isNotEmpty) ...[
            const SizedBox(height: 8),
            CareCalendarBeforeMonthStrip(
              petId: petId,
              items: result.beforeMonthItems,
            ),
          ],
          if (result.notices.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              l.careCalendarSparseMonthNotice,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 8),
          if (!hasAny)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 24),
              child: Semantics(
                identifier: 'care_calendar_empty_month',
                child: Column(
                  key: const Key('care_calendar_empty_month'),
                  children: [
                    Text(
                      l.careCalendarEmptyMonthTitle,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      l.careCalendarEmptyMonthBody,
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
            )
          else
            CareCalendarMonthGrid(
              petId: petId,
              month: month,
              itemsByDate: itemsByDate,
              overlayByDay: overlayByDay,
            ),
        ],
      ),
    );
  }
}

class CareCalendarMultiPetSurface extends StatelessWidget {
  const CareCalendarMultiPetSurface({
    super.key,
    required this.month,
    required this.rows,
    required this.onPreviousMonth,
    required this.onNextMonth,
    required this.onDayTap,
  });

  final DateTime month;
  final List<
    ({String petId, String petName, CareCalendarResult? data, Object? error})
  >
  rows;
  final VoidCallback onPreviousMonth;
  final VoidCallback onNextMonth;
  final void Function(String petId, CareCalendarDay day) onDayTap;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final monthLabel = DateFormat.yMMMM().format(month);
    final merged =
        <
          String,
          List<({String petId, String petName, CareCalendarItem item})>
        >{};
    for (final row in rows) {
      final data = row.data;
      if (data == null) continue;
      for (final day in data.days) {
        final list = merged.putIfAbsent(day.date, () => []);
        for (final item in day.items) {
          list.add((petId: row.petId, petName: row.petName, item: item));
        }
      }
    }
    for (final entry in merged.entries) {
      entry.value.sort((a, b) {
        final byPet = a.petName.compareTo(b.petName);
        if (byPet != 0) return byPet;
        final ta = a.item.scheduledTime ?? '';
        final tb = b.item.scheduledTime ?? '';
        return ta.compareTo(tb);
      });
    }

    final overlayByDay = <String, List<CareCalendarPlannedAbsenceOverlay>>{};
    for (final row in rows) {
      final data = row.data;
      if (data == null) continue;
      final perPet = plannedAbsenceOverlaysByDay(data.plannedAbsenceOverlays);
      for (final entry in perPet.entries) {
        final list = overlayByDay.putIfAbsent(entry.key, () => []);
        for (final overlay in entry.value) {
          if (!list.any((o) => o.absenceId == overlay.absenceId)) {
            list.add(overlay);
          }
        }
      }
    }

    final errors = rows.where((r) => r.error != null).toList();
    final beforeMonth =
        <({String petId, String petName, CareCalendarItem item})>[
          for (final row in rows)
            if (row.data != null)
              for (final item in row.data!.beforeMonthItems)
                (petId: row.petId, petName: row.petName, item: item),
        ];

    return Semantics(
      container: true,
      label: l.careCalendarSemanticsLabel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              IconButton(
                key: const Key('care_calendar_prev_month'),
                onPressed: onPreviousMonth,
                icon: const Icon(Icons.chevron_left),
              ),
              Expanded(
                child: Semantics(
                  header: true,
                  identifier: 'care_calendar_month_label',
                  child: Text(monthLabel, textAlign: TextAlign.center),
                ),
              ),
              IconButton(
                key: const Key('care_calendar_next_month'),
                onPressed: onNextMonth,
                icon: const Icon(Icons.chevron_right),
              ),
            ],
          ),
          if (errors.isNotEmpty)
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                for (final e in errors)
                  Chip(
                    key: Key('care_calendar_error_${e.petId}'),
                    label: Text(l.careCalendarCouldntLoadPet(e.petName)),
                  ),
              ],
            ),
          if (beforeMonth.isNotEmpty) ...[
            const SizedBox(height: 8),
            CareCalendarMultiBeforeMonthStrip(rows: beforeMonth),
          ],
          const SizedBox(height: 8),
          CareCalendarMonthGridMarkers(
            month: month,
            markers: merged,
            overlayByDay: overlayByDay,
          ),
        ],
      ),
    );
  }
}
