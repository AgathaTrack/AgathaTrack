import 'dart:ui' show Tristate;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/core/widgets/form/app_form_info_button.dart';
import 'package:pet_profile_app/features/pet_profile/presentation/widgets/pet_form/pet_form_neutered_section.dart';
import 'package:pet_profile_app/features/pet_profile/presentation/widgets/pet_form/pet_form_section.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

Widget _wrapNeutered({
  required Locale locale,
  bool? isNeutered,
  DateTime? neuteredDate,
  VoidCallback? onPickNeuteredDate,
  VoidCallback? onClearNeuteredDate,
}) {
  return MaterialApp(
    locale: locale,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(
      body: SizedBox(
        width: 320,
        child: SingleChildScrollView(
          child: PetFormSection(
            title: 'Health',
            children: [
              PetFormNeuteredSection(
                species: 'Dog',
                isNeutered: isNeutered,
                neuteredDate: neuteredDate,
                onNeuteredChanged: (_) {},
                onPickNeuteredDate: onPickNeuteredDate ?? () {},
                onClearNeuteredDate: onClearNeuteredDate ?? () {},
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('places info control on label row with full-width segments', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(320, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_wrapNeutered(locale: const Locale('en')));
    await tester.pumpAndSettle();

    expect(find.byType(AppFormInfoButton), findsOneWidget);
    expect(find.byKey(const Key('pet_neuter_segmented')), findsOneWidget);

    final segmented = tester.widget<SegmentedButton<PetNeuterSelection>>(
      find.byKey(const Key('pet_neuter_segmented')),
    );
    expect(segmented.showSelectedIcon, isTrue);

    final segmentRect = tester.getRect(
      find.byKey(const Key('pet_neuter_segmented')),
    );
    final sectionRect = tester.getRect(find.byType(PetFormSection));
    const sectionHorizontalPadding = 32.0;
    final expectedContentWidth = sectionRect.width - sectionHorizontalPadding;

    final infoRect = tester.getRect(find.byType(AppFormInfoButton));
    expect(segmentRect.top, greaterThan(infoRect.bottom));
    expect(segmentRect.width, closeTo(expectedContentWidth, 1));
  });

  testWidgets('info is not in the same row as SegmentedButton', (tester) async {
    await tester.binding.setSurfaceSize(const Size(320, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    await tester.pumpWidget(_wrapNeutered(locale: const Locale('fr')));
    await tester.pumpAndSettle();

    final infoCenter = tester.getCenter(find.byType(AppFormInfoButton));
    final segmentCenter = tester.getCenter(
      find.byKey(const Key('pet_neuter_segmented')),
    );
    expect(infoCenter.dy, lessThan(segmentCenter.dy - 20));
  });

  group('semantics', () {
    final neuteredOn = DateTime(2024, 3, 12);

    /// Every semantics node under the root, depth first.
    List<SemanticsNode> allNodes(WidgetTester tester) {
      final nodes = <SemanticsNode>[];
      void visit(SemanticsNode node) {
        nodes.add(node);
        node.visitChildren((child) {
          visit(child);
          return true;
        });
      }

      visit(
        tester
            .binding
            .renderViews
            .first
            .owner!
            .semanticsOwner!
            .rootSemanticsNode!,
      );
      return nodes;
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

    Future<void> pumpYesWithDate(
      WidgetTester tester, {
      Locale locale = const Locale('en'),
      DateTime? date,
      VoidCallback? onPick,
      VoidCallback? onClear,
    }) async {
      await tester.binding.setSurfaceSize(const Size(320, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        _wrapNeutered(
          locale: locale,
          isNeutered: true,
          neuteredDate: date,
          onPickNeuteredDate: onPick,
          onClearNeuteredDate: onClear,
        ),
      );
      await tester.pumpAndSettle();
    }

    semanticsTest('names the Yes/No/Unknown control as one group', (
      tester,
    ) async {
      await pumpYesWithDate(tester, date: neuteredOn);
      expect(find.bySemanticsLabel('Neutered or spayed?'), findsOneWidget);
    });

    semanticsTest('localises the group name in French', (tester) async {
      await pumpYesWithDate(
        tester,
        locale: const Locale('fr'),
        date: neuteredOn,
      );
      expect(find.bySemanticsLabel('Animal stérilisé ?'), findsOneWidget);
    });

    semanticsTest('exposes three toggle buttons inside the group', (
      tester,
    ) async {
      await pumpYesWithDate(tester, date: neuteredOn);

      final group = tester.getSemantics(
        find.bySemanticsLabel('Neutered or spayed?'),
      );
      final segments = <SemanticsNode>[];
      void collect(SemanticsNode node) {
        final data = node.getSemanticsData();
        if (data.flagsCollection.isButton &&
            data.flagsCollection.isSelected != Tristate.none) {
          segments.add(node);
        }
        node.visitChildren((child) {
          collect(child);
          return true;
        });
      }

      group.visitChildren((child) {
        collect(child);
        return true;
      });
      // Merge boundaries wrap each segment, so read the labels off the merged data.
      expect(segments.map((n) => n.getSemanticsData().label).toList(), [
        'Yes',
        'No',
        'Unknown',
      ]);
      expect(
        segments
            .where(
              (n) =>
                  n.getSemanticsData().flagsCollection.isSelected ==
                  Tristate.isTrue,
            )
            .map((n) => n.getSemanticsData().label),
        ['Yes'],
      );
    });

    semanticsTest('does not wrap the controls in a text-field style label', (
      tester,
    ) async {
      await pumpYesWithDate(tester, date: neuteredOn);

      final combined = allNodes(tester).where((n) {
        final label = n.getSemanticsData().label;
        return label.contains('Neutered / Spayed Date. ') ||
            label.contains('Neutered / Spayed Date.\n');
      });
      expect(combined, isEmpty);
      expect(
        allNodes(
          tester,
        ).where((n) => n.getSemanticsData().flagsCollection.isTextField),
        isEmpty,
      );
      // The visible field label is still announced on its own.
      expect(find.bySemanticsLabel('Neutered / Spayed Date'), findsOneWidget);
    });

    semanticsTest('date picker is a labelled button', (tester) async {
      await pumpYesWithDate(tester, date: neuteredOn);

      final data = tester
          .getSemantics(find.byKey(const Key('pet_neutered_date_field')))
          .getSemanticsData();
      expect(data.flagsCollection.isButton, isTrue);
      expect(data.hasAction(SemanticsAction.tap), isTrue);
      expect(data.label, contains('Date'));
      expect(data.label, contains('Mar 12, 2024'));
      expect(data.label, isNot(contains('Neutered')));
    });

    semanticsTest('date picker names the empty state', (tester) async {
      await pumpYesWithDate(tester);

      final data = tester
          .getSemantics(find.byKey(const Key('pet_neutered_date_field')))
          .getSemanticsData();
      expect(data.flagsCollection.isButton, isTrue);
      expect(data.label, contains('Select date'));
    });

    semanticsTest('clear date stays a separate reachable button', (
      tester,
    ) async {
      var picked = 0;
      var cleared = 0;
      await pumpYesWithDate(
        tester,
        date: neuteredOn,
        onPick: () => picked++,
        onClear: () => cleared++,
      );

      final clear = tester.getSemantics(find.byTooltip('Clear date'));
      final date = tester.getSemantics(
        find.byKey(const Key('pet_neutered_date_field')),
      );
      expect(clear.id, isNot(date.id));
      expect(clear.getSemanticsData().flagsCollection.isButton, isTrue);
      expect(date.getSemanticsData().label, isNot(contains('Clear date')));

      await tester.tap(find.byTooltip('Clear date'));
      await tester.pump();
      expect(cleared, 1);
      expect(picked, 0);

      await tester.tap(find.byKey(const Key('pet_neutered_date_field')));
      await tester.pump();
      expect(picked, 1);
    });

    semanticsTest('fits 320 px in French with a date selected', (tester) async {
      await pumpYesWithDate(
        tester,
        locale: const Locale('fr'),
        date: neuteredOn,
      );
      expect(tester.takeException(), isNull);
    });
  });
}
