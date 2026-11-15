import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/core/theme/app_theme.dart';
import 'package:pet_profile_app/features/pet_profile/domain/entities/pet.dart';
import 'package:pet_profile_app/features/pet_profile/domain/entities/profile_fact_status.dart';
import 'package:pet_profile_app/features/pet_profile/presentation/providers/pet_providers.dart';
import 'package:pet_profile_app/features/pet_profile/presentation/widgets/profile_fact_capture_sheet.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

class _RecordingPetListNotifier extends PetListNotifier {
  _RecordingPetListNotifier(this.initial);

  final List<Pet> initial;
  Pet? lastUpdated;

  @override
  Future<List<Pet>> build() async => initial;

  @override
  Future<void> updatePet(Pet pet) async {
    lastUpdated = pet;
    state = AsyncData([pet]);
  }
}

class _SheetLauncher extends ConsumerWidget {
  const _SheetLauncher({
    required this.pet,
    this.topic = ProfileFactCaptureTopic.neuter,
  });

  final Pet pet;
  final ProfileFactCaptureTopic topic;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Scaffold(
      body: ElevatedButton(
        onPressed: () =>
            showProfileFactCaptureSheet(context, ref, pet: pet, topic: topic),
        child: const Text('open'),
      ),
    );
  }
}

void main() {
  testWidgets('AC-IC-01: saving neuter no updates pet status', (tester) async {
    const pet = Pet(
      id: 'pet-1',
      name: 'Bella',
      species: 'Dog',
      neuterStatus: profileFactStatusUnknown,
    );
    final notifier = _RecordingPetListNotifier([pet]);

    await tester.pumpWidget(
      ProviderScope(
        overrides: [petListProvider.overrideWith(() => notifier)],
        child: MaterialApp(
          theme: AppTheme.lightTheme,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const _SheetLauncher(pet: pet),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('profile_fact_capture_sheet')), findsOneWidget);

    await tester.tap(find.text('No'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('profile_fact_capture_save')));
    await tester.pumpAndSettle();

    expect(notifier.lastUpdated?.neuterStatus, profileFactStatusNo);
    expect(notifier.lastUpdated?.neuterStatusSource, 'user');
    expect(find.byKey(const Key('profile_fact_capture_sheet')), findsNothing);
  });

  group('semantics and narrow layout', () {
    const pet = Pet(
      id: 'pet-1',
      name: 'Bella',
      species: 'Dog',
      neuterStatus: profileFactStatusUnknown,
    );

    Future<void> openSheet(
      WidgetTester tester, {
      required ProfileFactCaptureTopic topic,
      Locale locale = const Locale('en'),
    }) async {
      await tester.binding.setSurfaceSize(const Size(320, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            petListProvider.overrideWith(
              () => _RecordingPetListNotifier([pet]),
            ),
          ],
          child: MaterialApp(
            theme: AppTheme.lightTheme,
            locale: locale,
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            home: _SheetLauncher(pet: pet, topic: topic),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('profile_fact_capture_sheet')),
        findsOneWidget,
      );
    }

    Future<void> selectYes(WidgetTester tester, String yesLabel) async {
      await tester.tap(
        find.descendant(
          of: find.byKey(const Key('profile_fact_capture_segmented')),
          matching: find.text(yesLabel),
        ),
      );
      await tester.pumpAndSettle();
    }

    /// Runs [body] with semantics enabled and disposes the handle before the test ends.
    void semanticsTest(String name, Future<void> Function(WidgetTester) body) {
      testWidgets(name, (tester) async {
        final handle = tester.ensureSemantics();
        try {
          await body(tester);
        } finally {
          handle.dispose();
        }
      });
    }

    /// The Yes/No/Unknown toggle buttons under the semantics node named [groupLabel].
    /// The label can also match a visible title, so use the node that owns the segments.
    List<SemanticsNode> segmentNodes(WidgetTester tester, String groupLabel) {
      List<SemanticsNode> segmentsUnder(SemanticsNode root) {
        final found = <SemanticsNode>[];
        void collect(SemanticsNode node) {
          final flags = node.getSemanticsData().flagsCollection;
          if (flags.isButton && flags.isSelected != Tristate.none) {
            found.add(node);
          }
          node.visitChildren((child) {
            collect(child);
            return true;
          });
        }

        root.visitChildren((child) {
          collect(child);
          return true;
        });
        return found;
      }

      List<SemanticsNode> best = const [];
      void search(SemanticsNode node) {
        if (best.isEmpty && node.getSemanticsData().label == groupLabel) {
          best = segmentsUnder(node);
        }
        node.visitChildren((child) {
          search(child);
          return true;
        });
      }

      search(
        tester
            .binding
            .renderViews
            .first
            .owner!
            .semanticsOwner!
            .rootSemanticsNode!,
      );
      return best;
    }

    semanticsTest('neuter topic: named group of three toggle buttons', (
      tester,
    ) async {
      await openSheet(tester, topic: ProfileFactCaptureTopic.neuter);

      expect(
        find.byKey(const Key('profile_fact_capture_segmented')),
        findsOneWidget,
      );
      expect(find.bySemanticsLabel('Neutered or spayed?'), findsOneWidget);
      expect(
        segmentNodes(
          tester,
          'Neutered or spayed?',
        ).map((n) => n.getSemanticsData().label),
        ['Yes', 'No', 'Unknown'],
      );
    });

    semanticsTest('chip topic: group is named by the chip title', (
      tester,
    ) async {
      await openSheet(tester, topic: ProfileFactCaptureTopic.chip);

      expect(find.bySemanticsLabel('Record microchip status'), findsWidgets);
      expect(find.bySemanticsLabel('Neutered or spayed?'), findsNothing);
      expect(
        segmentNodes(
          tester,
          'Record microchip status',
        ).map((n) => n.getSemanticsData().label),
        ['Yes', 'No', 'Unknown'],
      );
    });

    semanticsTest('neuter topic: date is a labelled button, not a text field', (
      tester,
    ) async {
      await openSheet(tester, topic: ProfileFactCaptureTopic.neuter);
      await selectYes(tester, 'Yes');

      final date = tester
          .getSemantics(
            find.byKey(const Key('profile_fact_capture_neuter_date')),
          )
          .getSemanticsData();
      expect(date.flagsCollection.isButton, isTrue);
      expect(date.hasAction(SemanticsAction.tap), isTrue);
      expect(date.label, contains('Date'));
      expect(date.label, contains('Select date'));
      expect(date.flagsCollection.isTextField, isFalse);
    });

    for (final topic in ProfileFactCaptureTopic.values) {
      testWidgets('fits 320 px in French with Oui selected (${topic.name})', (
        tester,
      ) async {
        await openSheet(tester, topic: topic, locale: const Locale('fr'));
        await selectYes(tester, 'Oui');

        expect(tester.takeException(), isNull);
        final segmented = tester.getRect(
          find.byKey(const Key('profile_fact_capture_segmented')),
        );
        expect(segmented.left, greaterThanOrEqualTo(0));
        expect(segmented.right, lessThanOrEqualTo(320));
        // The follow-up field for the chosen topic is on screen too.
        expect(
          find.byKey(
            Key(
              topic == ProfileFactCaptureTopic.neuter
                  ? 'profile_fact_capture_neuter_date'
                  : 'profile_fact_capture_chip_id',
            ),
          ),
          findsOneWidget,
        );
      });
    }
  });
}
