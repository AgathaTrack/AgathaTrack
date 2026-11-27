import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:pet_profile_app/l10n/app_localizations.dart';
import '../../domain/care_calendar_overlay_index.dart';
import '../../domain/entities/care_calendar.dart';
import 'care_calendar_before_month_strip.dart';
import 'care_calendar_day_cell.dart';

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
    final overlayByDate = indexCareCalendarOverlays(
      petId: petId,
      overlays: result.plannedAbsenceOverlays,
    );
    final hasCare = result.days.any((d) => d.items.isNotEmpty);
    final hasOverlay = result.plannedAbsenceOverlays.isNotEmpty;

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
          if (hasOverlay) ...[
            const SizedBox(height: 4),
            Text(
              l.careCalendarAbsenceOverlayLegend,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 8),
          if (!hasCare && !hasOverlay)
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
            _MonthGrid(
              petId: petId,
              month: month,
              itemsByDate: itemsByDate,
              overlayByDate: overlayByDate,
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
          List<CareCalendarDayMarker>
        >{};
    final overlayMaps = <Map<String, List<CareCalendarOverlayRef>>>[];
    for (final row in rows) {
      final data = row.data;
      if (data == null) continue;
      overlayMaps.add(
        indexCareCalendarOverlays(
          petId: row.petId,
          overlays: data.plannedAbsenceOverlays,
        ),
      );
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

    final overlayByDate = mergeCareCalendarOverlayMaps(overlayMaps);
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
          if (overlayByDate.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              l.careCalendarAbsenceOverlayLegend,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          const SizedBox(height: 8),
          _MonthGridMarkers(
            month: month,
            markers: merged,
            overlayByDate: overlayByDate,
          ),
        ],
      ),
    );
  }
}

class _MonthGrid extends StatelessWidget {
  const _MonthGrid({
    required this.petId,
    required this.month,
    required this.itemsByDate,
    required this.overlayByDate,
  });

  final String petId;
  final DateTime month;
  final Map<String, List<CareCalendarItem>> itemsByDate;
  final Map<String, List<CareCalendarOverlayRef>> overlayByDate;

  @override
  Widget build(BuildContext context) {
    final markers = itemsByDate.map(
      (key, value) => MapEntry(
        key,
        value
            .map((i) => (petId: petId, petName: '', item: i))
            .toList(growable: false),
      ),
    );
    return _MonthGridMarkers(
      month: month,
      markers: markers,
      petId: petId,
      overlayByDate: overlayByDate,
    );
  }
}

class _MonthGridMarkers extends StatelessWidget {
  const _MonthGridMarkers({
    required this.month,
    required this.markers,
    required this.overlayByDate,
    this.petId,
  });

  final DateTime month;
  final Map<String, List<CareCalendarDayMarker>> markers;
  final Map<String, List<CareCalendarOverlayRef>> overlayByDate;
  final String? petId;

  @override
  Widget build(BuildContext context) {
    final firstOfMonth = DateTime(month.year, month.month);
    final firstWeekday = firstOfMonth.weekday % 7;
    final gridStart = firstOfMonth.subtract(Duration(days: firstWeekday));
    final weekdays = MaterialLocalizations.of(context).narrowWeekdays;

    return Column(
      children: [
        Row(
          children: [
            for (final label in weekdays)
              Expanded(
                child: Center(
                  child: Text(
                    label,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 4),
        for (var week = 0; week < 6; week++)
          Row(
            children: [
              for (var day = 0; day < 7; day++)
                Expanded(
                  child: Builder(
                    builder: (context) {
                      final cellDate = gridStart.add(
                        Duration(days: week * 7 + day),
                      );
                      final iso = DateFormat('yyyy-MM-dd').format(cellDate);
                      return CareCalendarDayCell(
                        date: cellDate,
                        markers: markers[iso] ?? const [],
                        overlays: overlayByDate[iso] ?? const [],
                        defaultPetId: petId,
                      );
                    },
                  ),
                ),
            ],
          ),
      ],
    );
  }
}