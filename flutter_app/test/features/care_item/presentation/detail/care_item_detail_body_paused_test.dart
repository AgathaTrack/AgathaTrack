import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/core/providers/api_base_url_provider.dart';
import 'package:pet_profile_app/core/theme/app_theme.dart';
import 'package:pet_profile_app/features/experience/presentation/care_item/detail/care_item_detail_body.dart';
import 'package:pet_profile_app/features/health_tracking/data/models/health_entry_absence_context_model.dart';
import 'package:pet_profile_app/features/health_tracking/domain/entities/health_entry.dart';
import 'package:pet_profile_app/features/health_tracking/domain/entities/health_history_entry.dart';
import 'package:pet_profile_app/features/health_tracking/presentation/providers/care_item_absence_providers.dart';
import 'package:pet_profile_app/features/health_tracking/presentation/providers/health_providers.dart';
import 'package:pet_profile_app/features/health_tracking/presentation/providers/occurrence_providers.dart';
import 'package:pet_profile_app/features/health_tracking/presentation/providers/pet_event_view_providers.dart';
import 'package:pet_profile_app/features/pet_profile/domain/entities/pet.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

import '../../../../helpers/care_schedule_entries.dart';
import 'care_item_paused_test_support.dart';

class _Notifier extends HealthEntriesNotifier {
  @override
  Future<List<HealthEntry>> build() async => [];

  @override
  Future<void> refresh() async {}
}

const _pet = Pet(
  id: 'pet-1',
  name: 'Bella',
  species: 'Dog',
  colorValue: 0xFF2196F3,
);

Future<void> _pumpBody(WidgetTester tester, HealthEntry entry) async {
  tester.view.physicalSize = const Size(400, 1600);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        apiBaseUrlProvider.overrideWithValue('http://test.local'),
        healthEntriesNotifierProvider.overrideWith(_Notifier.new),
        careItemAbsenceContextProvider(entry.id).overrideWith(
          (ref) async => HealthEntryAbsenceContext(
            healthEntryId: entry.id,
            petId: 'pet-1',
            absences: const [],
          ),
        ),
        entryOccurrencesProvider(entry.id).overrideWith((ref) async => []),
        entryPastOccurrencesProvider(entry.id).overrideWith((ref) async => []),
        healthEntryPhotosProvider(entry.id).overrideWith((ref) async => []),
      ],
      child: MaterialApp(
        theme: AppTheme.lightTheme,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(
          body: CareItemDetailBody(
            petId: 'pet-1',
            entry: entry,
            pet: _pet,
            historyAsync: const AsyncValue.data(<HealthHistoryEntry>[]),
            entryId: entry.id,
            isClosed: false,
            isEstablished: false,
            onSeeHistory: () {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'control: active scheduled item offers Done on its open occurrence',
    (tester) async {
      await _pumpBody(tester, scheduledEntry(id: 'pill', name: 'Pill'));

      expect(find.byKey(const Key('care_item_paused_banner')), findsNothing);
      expect(
        find.byKey(const Key('care_item_occurrence_done_pill-occ')),
        findsOneWidget,
      );
    },
  );

  testWidgets('paused scheduled item routes to the banner with no actions', (
    tester,
  ) async {
    final paused = scheduledEntry(
      id: 'pill',
      name: 'Pill',
      entryStatus: 'paused',
    ).copyWith(pausedSince: careToday());
    expect(paused.schedule!.openOccurrences, isNotEmpty);

    await _pumpBody(tester, paused);

    expect(find.byKey(const Key('care_item_paused_banner')), findsOneWidget);
    expectNoOccurrenceActions('pill-occ');
  });
}
