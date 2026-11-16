import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/core/utils/calendar_date.dart';
import 'package:pet_profile_app/features/care_item/care_item.dart';
import 'package:pet_profile_app/features/health_tracking/domain/entities/health_entry.dart';
import 'package:pet_profile_app/features/experience/presentation/care_item/detail/care_item_dates_section.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

import 'care_item_paused_test_support.dart';

CareItemSchedule _pausedSchedule() {
  final today = calendarDateOnly(DateTime.now());
  return CareItemSchedule(
    entryId: 'entry-1',
    petId: 'pet-1',
    name: 'Heartworm',
    isFixedSchedule: false,
    status: 'paused',
    openOccurrences: [
      OpenOccurrence(
        id: 'occ-open',
        date: today,
        time: '08:00',
        status: CareOccurrenceStatus.due,
        origin: CareOccurrenceOrigin.computed,
      ),
    ],
    asOf: CareAsOf(date: today, time: '12:00', timezone: 'UTC'),
  );
}

Future<void> _pump(WidgetTester tester, HealthEntry entry) async {
  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: CareItemDatesSection(entry: entry, muted: false)),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  final entry = HealthEntry(
    id: 'entry-1',
    petId: 'pet-1',
    name: 'Heartworm',
    type: HealthEntryType.preventive,
    frequency: HealthFrequency.monthly,
    frequencyInterval: 1,
    startDate: DateTime(2025, 1, 1),
    nextDueDate: DateTime(2025, 6, 1),
  );

  testWidgets(
    'active item without schedule shows read-only legacy summary only',
    (tester) async {
      await _pump(tester, entry);

      expect(find.byKey(const Key('care_item_dates_section')), findsOneWidget);
      expect(
        find.byKey(const Key('care_item_dates_summary_entry-1')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('care_item_paused_banner')), findsNothing);
      expect(find.byType(ButtonStyleButton), findsNothing);
      expectNoOccurrenceActions('occ-open');
    },
  );

  testWidgets(
    'paused item with open occurrences shows only the paused banner',
    (tester) async {
      final today = calendarDateOnly(DateTime.now());
      await _pump(
        tester,
        entry.copyWith(
          status: 'paused',
          pausedSince: today.subtract(const Duration(days: 3)),
          schedule: _pausedSchedule(),
        ),
      );

      expect(find.byKey(const Key('care_item_paused_banner')), findsOneWidget);
      expect(find.byType(ButtonStyleButton), findsNothing);
      expectNoOccurrenceActions('occ-open');
    },
  );

  testWidgets(
    'paused item without schedule shows paused banner and no actions',
    (tester) async {
      final today = calendarDateOnly(DateTime.now());
      await _pump(tester, entry.copyWith(status: 'paused', pausedSince: today));

      expect(find.byKey(const Key('care_item_paused_banner')), findsOneWidget);
      expect(find.byType(ButtonStyleButton), findsNothing);
      expectNoOccurrenceActions('occ-open');
    },
  );
}
