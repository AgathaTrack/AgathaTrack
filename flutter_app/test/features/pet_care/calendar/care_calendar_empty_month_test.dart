import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/pet_care/calendar/domain/entities/care_calendar.dart';
import 'package:pet_profile_app/features/pet_care/calendar/presentation/widgets/care_calendar_surface.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

CareCalendarResult _emptyMonth() {
  const days = <CareCalendarDay>[
    CareCalendarDay(date: '2026-11-01', items: []),
    CareCalendarDay(date: '2026-11-02', items: []),
  ];
  return const CareCalendarResult(
    petId: 'pet-1',
    asOf: CareCalendarAsOf(date: '2026-11-01', time: '12:00', timezone: 'UTC'),
    startsOn: '2026-11-01',
    endsOn: '2026-11-02',
    projectionStatus: 'complete',
    beforeMonthItems: [],
    days: days,
  );
}

void main() {
  testWidgets('sparse month shows empty-state copy', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: CareCalendarSurface(
            petId: 'pet-1',
            month: DateTime(2026, 11),
            result: _emptyMonth(),
            onPreviousMonth: () {},
            onNextMonth: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.byKey(const Key('care_calendar_empty_month')), findsOneWidget);
    expect(find.text('No care on this month yet'), findsOneWidget);
  });
}