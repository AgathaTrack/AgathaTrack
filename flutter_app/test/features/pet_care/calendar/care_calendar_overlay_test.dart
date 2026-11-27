import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/pet_care/calendar/domain/entities/care_calendar.dart';
import 'package:pet_profile_app/features/pet_care/calendar/presentation/widgets/care_calendar_surface.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  CareCalendarResult fixture({List<CareCalendarItem> items = const []}) {
    return CareCalendarResult(
      petId: 'pet-1',
      asOf: const CareCalendarAsOf(
        date: '2026-11-15',
        time: '10:00',
        timezone: 'UTC',
      ),
      startsOn: '2026-11-01',
      endsOn: '2026-11-30',
      projectionStatus: 'complete',
      beforeMonthItems: const [],
      days: [
        const CareCalendarDay(date: '2026-11-10', items: []),
        CareCalendarDay(date: '2026-11-11', items: items),
      ],
      plannedAbsenceOverlays: const [
        CareCalendarPlannedAbsenceOverlay(
          absenceId: 'abs-1',
          startsOn: '2026-11-10',
          endsOn: '2026-11-12',
          overlayStartsOn: '2026-11-10',
          overlayEndsOn: '2026-11-12',
          declarerIsViewer: true,
          canOpenAwayPlan: true,
        ),
      ],
    );
  }

  Future<void> pumpCalendar(
    WidgetTester tester, {
    required CareCalendarResult result,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: CareCalendarSurface(
            petId: 'pet-1',
            month: DateTime(2026, 11),
            result: result,
            onPreviousMonth: () {},
            onNextMonth: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('renders absence overlay semantics without care badge', (tester) async {
    await pumpCalendar(tester, result: fixture());

    expect(
      find.byWidgetPredicate(
        (w) =>
            w is Semantics &&
            w.properties.identifier == 'care_calendar_day_2026-11-10_absence',
      ),
      findsOneWidget,
    );
    expect(find.byType(Badge), findsNothing);
  });

  testWidgets('mixed day keeps care badge and absence semantics', (tester) async {
    const careItem = CareCalendarItem(
      healthEntryId: 'entry-1',
      occurrenceId: 'occ-1',
      scheduledDate: '2026-11-11',
      displayStatus: 'due',
      source: 'materialised',
      name: 'Walk',
    );
    await pumpCalendar(tester, result: fixture(items: const [careItem]));

    expect(find.byType(Badge), findsOneWidget);
    expect(
      find.byWidgetPredicate(
        (w) =>
            w is Semantics &&
            w.properties.identifier == 'care_calendar_day_2026-11-11_absence',
      ),
      findsOneWidget,
    );
  });
}