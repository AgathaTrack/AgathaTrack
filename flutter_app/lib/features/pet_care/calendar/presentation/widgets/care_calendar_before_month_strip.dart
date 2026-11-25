import 'package:flutter/material.dart';

import 'package:pet_profile_app/core/router/shell_return_navigation.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

import '../../domain/entities/care_calendar.dart';

class CareCalendarMultiBeforeMonthStrip extends StatelessWidget {
  const CareCalendarMultiBeforeMonthStrip({super.key, required this.rows});

  final List<({String petId, String petName, CareCalendarItem item})> rows;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Semantics(
      container: true,
      identifier: 'care_calendar_before_month',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l.careCalendarBeforeMonth,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 4),
          for (final row in rows)
            ListTile(
              dense: true,
              title: Text(row.item.name),
              subtitle: Text(
                row.petName.isEmpty
                    ? row.item.scheduledDate
                    : '${row.petName} · ${row.item.scheduledDate}',
              ),
              onTap: row.item.isMaterialised
                  ? () => openOccurrenceScreen(
                      context,
                      petId: row.petId,
                      entryId: row.item.healthEntryId,
                      occurrenceId: row.item.occurrenceId!,
                      source: 'care_calendar',
                    )
                  : null,
            ),
        ],
      ),
    );
  }
}

class CareCalendarBeforeMonthStrip extends StatelessWidget {
  const CareCalendarBeforeMonthStrip({
    super.key,
    required this.petId,
    required this.items,
  });

  final String petId;
  final List<CareCalendarItem> items;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return Semantics(
      container: true,
      identifier: 'care_calendar_before_month',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            l.careCalendarBeforeMonth,
            style: Theme.of(context).textTheme.labelLarge,
          ),
          const SizedBox(height: 4),
          for (final item in items)
            ListTile(
              dense: true,
              title: Text(item.name),
              subtitle: Text(item.scheduledDate),
              onTap: item.isMaterialised
                  ? () => openOccurrenceScreen(
                      context,
                      petId: petId,
                      entryId: item.healthEntryId,
                      occurrenceId: item.occurrenceId!,
                      source: 'care_calendar',
                    )
                  : null,
            ),
        ],
      ),
    );
  }
}