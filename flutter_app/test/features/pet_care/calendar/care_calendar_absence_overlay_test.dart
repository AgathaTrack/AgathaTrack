import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
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

Widget _calendarUnderTest(GoRouter router) {
  return MaterialApp.router(
    routerConfig: router,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
  );
}

void main() {
  testWidgets('absence-only day shows luggage without care badge', (
    tester,
  ) async {
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => Scaffold(
            body: CareCalendarSurface(
              petId: 'pet-1',
              month: DateTime(2026, 11),
              result: _monthWithAbsenceOverlay(),
              onPreviousMonth: () {},
              onNextMonth: () {},
            ),
          ),
        ),
      ],
    );
    await tester.pumpWidget(_calendarUnderTest(router));
    await tester.pump();
    await tester.pump();

    expect(
      find.bySemanticsIdentifier('care_calendar_day_2026-11-10'),
      findsOneWidget,
    );
    expect(find.byIcon(Icons.luggage_outlined), findsWidgets);
    expect(find.byKey(const Key('care_calendar_empty_month')), findsNothing);
  });

  testWidgets('mixed day keeps care badge while overlay is active', (
    tester,
  ) async {
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => Scaffold(
            body: CareCalendarSurface(
              petId: 'pet-1',
              month: DateTime(2026, 11),
              result: _monthWithAbsenceOverlay(),
              onPreviousMonth: () {},
              onNextMonth: () {},
            ),
          ),
        ),
      ],
    );
    await tester.pumpWidget(_calendarUnderTest(router));
    await tester.pump();
    await tester.pump();

    expect(find.byType(Badge), findsOneWidget);
    expect(
      find.bySemanticsIdentifier('care_calendar_day_2026-11-11'),
      findsOneWidget,
    );
  });

  testWidgets('absence-only tap opens pet away plan route', (tester) async {
    const awayOpened = Key('away_plan_opened');
    final router = GoRouter(
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) => Scaffold(
            body: CareCalendarSurface(
              petId: 'pet-1',
              month: DateTime(2026, 11),
              result: _monthWithAbsenceOverlay(),
              onPreviousMonth: () {},
              onNextMonth: () {},
            ),
          ),
        ),
        GoRoute(
          path: '/pc/away/:absenceId/pets/:petId',
          builder: (context, state) => Scaffold(
            key: awayOpened,
            body: Text(state.pathParameters['absenceId']!),
          ),
        ),
      ],
    );
    await tester.pumpWidget(_calendarUnderTest(router));
    await tester.pump();
    await tester.pump();

    final absenceDay = find.bySemanticsIdentifier(
      'care_calendar_day_2026-11-10',
    );
    final semantics = tester.getSemantics(absenceDay);
    expect(semantics.hasFlag(SemanticsFlag.isButton), isTrue);

    await tester.tap(absenceDay);
    await tester.pumpAndSettle();

    expect(find.byKey(awayOpened), findsOneWidget);
  });
}
