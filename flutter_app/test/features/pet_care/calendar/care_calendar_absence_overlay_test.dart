import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/pet_care/calendar/domain/entities/care_calendar.dart';
import 'package:pet_profile_app/features/pet_care/calendar/presentation/widgets/care_calendar_surface.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

CareCalendarResult _monthWithAbsenceOverlay() {
  const overlay = CareCalendarPlannedAbsenceOverlay(
    absenceId: 'abs-1',
    startsOn: '2026-11-10',
    endsOn: '2026-11-12',
    overlayStartsOn: '2026-11-10',
    overlayEndsOn: '2026-11-12',
    declarerIsViewer: true,
    canOpenAwayPlan: true,
    title: 'Trip',
  );
  return const CareCalendarResult(
    petId: 'pet-1',
    asOf: CareCalendarAsOf(date: '2026-11-01', time: '12:00', timezone: 'UTC'),
    startsOn: '2026-11-01',
    endsOn: '2026-11-30',
    projectionStatus: 'complete',
    beforeMonthItems: [],
    days: [
      CareCalendarDay(date: '2026-11-10', items: []),
      CareCalendarDay(
        date: '2026-11-11',
        items: [
          CareCalendarItem(
            healthEntryId: 'e1',
            occurrenceId: 'occ-1',
            scheduledDate: '2026-11-11',
            displayStatus: 'coming_up',
            source: 'materialised',
            name: 'Care',
          ),
        ],
      ),
    ],
    plannedAbsenceOverlays: [overlay],
  );
}

void main() {
  testWidgets('absence overlay shows icon without care badge', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: CareCalendarSurface(
            petId: 'pet-1',
            month: DateTime(2026, 11),
            result: _monthWithAbsenceOverlay(),
            onPreviousMonth: () {},
            onNextMonth: () {},
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(
      find.bySemanticsIdentifier('care_calendar_day_2026-11-10'),
      findsOneWidget,
    );
    expect(find.byIcon(Icons.luggage_outlined), findsWidgets);
    expect(find.byKey(const Key('care_calendar_empty_month')), findsNothing);
  });
}
