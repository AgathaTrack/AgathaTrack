import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:pet_profile_app/core/router/shell_return_navigation.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';
import '../../domain/entities/care_calendar.dart';

class CareCalendarMonthGrid extends StatelessWidget {
  const CareCalendarMonthGrid({
    super.key,
    required this.petId,
    required this.month,
    required this.itemsByDate,
    required this.overlayByDay,
  });

  final String petId;
  final DateTime month;
  final Map<String, List<CareCalendarItem>> itemsByDate;
  final Map<String, List<CareCalendarDayAbsenceOverlay>> overlayByDay;

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
    return CareCalendarMonthGridMarkers(
      month: month,
      markers: markers,
      petId: petId,
      overlayByDay: overlayByDay,
    );
  }
}

class CareCalendarMonthGridMarkers extends StatelessWidget {
  const CareCalendarMonthGridMarkers({
    super.key,
    required this.month,
    required this.markers,
    this.petId,
    this.overlayByDay = const {},
  });

  final DateTime month;
  final Map<
    String,
    List<({String petId, String petName, CareCalendarItem item})>
  >
  markers;
  final String? petId;
  final Map<String, List<CareCalendarDayAbsenceOverlay>> overlayByDay;

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
                  child: CareCalendarDayCell(
                    date: gridStart.add(Duration(days: week * 7 + day)),
                    markers:
                        markers[DateFormat('yyyy-MM-dd').format(
                          gridStart.add(Duration(days: week * 7 + day)),
                        )] ??
                        const [],
                    absenceOverlays:
                        overlayByDay[DateFormat('yyyy-MM-dd').format(
                          gridStart.add(Duration(days: week * 7 + day)),
                        )] ??
                        const [],
                    petId: petId,
                  ),
                ),
            ],
          ),
      ],
    );
  }
}

class CareCalendarDayCell extends StatelessWidget {
  const CareCalendarDayCell({
    super.key,
    required this.date,
    required this.markers,
    required this.absenceOverlays,
    this.petId,
  });

  final DateTime date;
  final List<({String petId, String petName, CareCalendarItem item})> markers;
  final List<CareCalendarDayAbsenceOverlay> absenceOverlays;
  final String? petId;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final iso = DateFormat('yyyy-MM-dd').format(date);
    final count = markers.length;
    final hasAbsenceOverlay = absenceOverlays.isNotEmpty;
    final hasProjectedOnly =
        count > 0 && markers.every((row) => row.item.isProjected);
    CareCalendarDayAbsenceOverlay? openableEntry;
    for (final entry in absenceOverlays) {
      if (entry.overlay.canOpenAwayPlan) {
        openableEntry = entry;
        break;
      }
    }
    final absenceOnlyTap = count == 0 && openableEntry != null;

    final semanticsParts = <String>[
      if (count > 0) l.careCalendarDaySheetTitle(iso),
      if (hasAbsenceOverlay) l.careCalendarAbsenceOverlayDay,
    ];

    return Semantics(
      button: count > 0 || absenceOnlyTap,
      label: semanticsParts.isEmpty ? null : semanticsParts.join(', '),
      identifier: 'care_calendar_day_$iso',
      child: InkWell(
        onTap: count == 0
            ? (absenceOnlyTap
                  ? () => openPetAwayPlan(
                      context,
                      openableEntry!.overlay.absenceId,
                      openableEntry.petId,
                    )
                  : null)
            : () => _onTap(context, iso, markers),
        child: DecoratedBox(
          decoration: hasAbsenceOverlay
              ? BoxDecoration(
                  color: Theme.of(
                    context,
                  ).colorScheme.surfaceContainerHighest.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(6),
                )
              : const BoxDecoration(),
          child: SizedBox(
            height: 48,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    '${date.day}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  if (count > 0)
                    Badge(
                      isLabelVisible: true,
                      backgroundColor: hasProjectedOnly
                          ? Theme.of(
                              context,
                            ).colorScheme.surfaceContainerHighest
                          : null,
                      label: Text(
                        count > 1 ? '$count' : '•',
                        style: hasProjectedOnly
                            ? Theme.of(context).textTheme.labelSmall
                            : null,
                      ),
                    )
                  else if (hasAbsenceOverlay)
                    Icon(
                      Icons.luggage_outlined,
                      size: 14,
                      color: Theme.of(context).colorScheme.outline,
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _onTap(
    BuildContext context,
    String iso,
    List<({String petId, String petName, CareCalendarItem item})> rows,
  ) {
    if (rows.length == 1 && rows.first.item.isMaterialised) {
      final item = rows.first.item;
      openOccurrenceScreen(
        context,
        petId: petId ?? rows.first.petId,
        entryId: item.healthEntryId,
        occurrenceId: item.occurrenceId!,
        source: 'care_calendar',
      );
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) =>
          CareCalendarDaySheet(date: iso, rows: rows, fallbackPetId: petId),
    );
  }
}

class CareCalendarDaySheet extends StatelessWidget {
  const CareCalendarDaySheet({
    super.key,
    required this.date,
    required this.rows,
    this.fallbackPetId,
  });

  final String date;
  final List<({String petId, String petName, CareCalendarItem item})> rows;
  final String? fallbackPetId;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(l.careCalendarDaySheetTitle(date)),
          ),
          for (final row in rows)
            ListTile(
              title: Text(row.item.name),
              subtitle: Text(
                row.petName.isEmpty ? row.item.displayStatus : row.petName,
              ),
              onTap: row.item.isMaterialised
                  ? () {
                      Navigator.of(context).pop();
                      openOccurrenceScreen(
                        context,
                        petId: fallbackPetId ?? row.petId,
                        entryId: row.item.healthEntryId,
                        occurrenceId: row.item.occurrenceId!,
                        source: 'care_calendar',
                      );
                    }
                  : null,
            ),
        ],
      ),
    );
  }
}
