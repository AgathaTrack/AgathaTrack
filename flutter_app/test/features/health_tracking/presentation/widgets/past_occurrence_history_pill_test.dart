import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/core/theme/app_theme.dart';
import 'package:pet_profile_app/core/weight/weight_unit.dart';
import 'package:pet_profile_app/core/weight/weight_unit_preference.dart';
import 'package:pet_profile_app/features/health_tracking/domain/entities/health_history_entry.dart';
import 'package:pet_profile_app/features/health_tracking/domain/entities/health_occurrence.dart';
import 'package:pet_profile_app/features/health_tracking/presentation/widgets/past_occurrence_history_pill.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

Widget _pillHarness(Widget child) {
  return ProviderScope(
    overrides: [
      weightUnitPreferenceProvider.overrideWith((ref) => WeightUnit.kg),
    ],
    child: MaterialApp(
      theme: AppTheme.lightTheme,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(body: child),
    ),
  );
}

void main() {
  testWidgets('done pill hides same-day close date but keeps icon', (
    tester,
  ) async {
    await tester.pumpWidget(
      _pillHarness(
        PastOccurrenceHistoryPill(
          occurrence: HealthOccurrence(
            id: 'o1',
            entryId: 'e1',
            scheduledDate: DateTime(2026, 11, 7),
            scheduledTime: '09:00',
            status: 'completed',
            completedOn: DateTime(2026, 11, 7),
          ),
          muted: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('07 Nov 26 at 09:00'), findsOneWidget);
    expect(find.text(' 07 Nov 26'), findsNothing);
    expect(find.text('Done'), findsNothing);
    expect(find.textContaining('Skipped'), findsNothing);
    expect(find.byIcon(Icons.check_circle), findsOneWidget);
    final semantics = tester.getSemantics(
      find.byType(PastOccurrenceHistoryPill),
    );
    expect(semantics.label, contains('done 07 Nov 26'));
  });

  testWidgets('done pill shows close date when the day differs', (
    tester,
  ) async {
    await tester.pumpWidget(
      _pillHarness(
        PastOccurrenceHistoryPill(
          occurrence: HealthOccurrence(
            id: 'o1b',
            entryId: 'e1',
            scheduledDate: DateTime(2026, 11, 7),
            scheduledTime: '09:00',
            status: 'completed',
            completedOn: DateTime(2026, 11, 9),
          ),
          muted: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('09 Nov 26'), findsOneWidget);
  });

  testWidgets('done pill shows linked weight in leading text and a11y', (
    tester,
  ) async {
    await tester.pumpWidget(
      _pillHarness(
        PastOccurrenceHistoryPill(
          occurrence: HealthOccurrence(
            id: 'o1c',
            entryId: 'e1',
            scheduledDate: DateTime(2026, 11, 7),
            status: 'completed',
            completedOn: DateTime(2026, 11, 7),
            linkedWeight: const HealthHistoryLinkedWeight(valueKg: 10.0),
          ),
          muted: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('10.0 kg'), findsOneWidget);
    final semantics = tester.getSemantics(
      find.byType(PastOccurrenceHistoryPill),
    );
    expect(semantics.label, contains('10.0 kg'));
  });

  testWidgets('skipped pill uses marked day for close when near midnight UTC', (
    tester,
  ) async {
    await tester.pumpWidget(
      _pillHarness(
        PastOccurrenceHistoryPill(
          occurrence: HealthOccurrence(
            id: 'o3',
            entryId: 'e1',
            scheduledDate: DateTime(2026, 11, 6),
            status: 'skipped',
            markedAt: DateTime.utc(2026, 11, 7, 0, 30),
          ),
          muted: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('07 Nov 26'), findsOneWidget);
  });

  testWidgets('tappable pill fits 320px wide without overflow', (tester) async {
    await tester.pumpWidget(
      _pillHarness(
        SizedBox(
          width: 320,
          child: PastOccurrenceHistoryPill(
            occurrence: HealthOccurrence(
              id: 'o4',
              entryId: 'e1',
              scheduledDate: DateTime(2026, 11, 7),
              scheduledTime: '09:00',
              status: 'completed',
              completedOn: DateTime(2026, 11, 9),
              linkedWeight: const HealthHistoryLinkedWeight(valueKg: 12.3),
            ),
            muted: false,
            onTap: () {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final box = tester.renderObject<RenderBox>(
      find.byKey(const Key('pet_event_past_occurrence_o4')),
    );
    expect(box.size.height, greaterThanOrEqualTo(48));
  });

  testWidgets('not recorded pill has icon only on the right', (tester) async {
    await tester.pumpWidget(
      _pillHarness(
        PastOccurrenceHistoryPill(
          occurrence: HealthOccurrence(
            id: 'o2',
            entryId: 'e1',
            scheduledDate: DateTime(2026, 11, 5),
            status: 'not_recorded',
          ),
          muted: false,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.help_outline), findsOneWidget);
    expect(find.text('Not recorded'), findsNothing);
  });
}
