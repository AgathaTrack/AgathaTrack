import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pet_profile_app/features/pet_care/context/data/models/planned_absence_model.dart';
import 'package:pet_profile_app/features/pet_care/context/domain/entities/planned_absence.dart';
import 'package:pet_profile_app/features/pet_care/context/domain/entities/planned_absence_pet_carer.dart';
import 'package:pet_profile_app/features/pet_care/context/presentation/away_plan_carer_invite_offer.dart';
import 'package:pet_profile_app/features/pet_care/context/presentation/away_plan_carer_invite_offer_dialog.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';

PlannedAbsence _absence(List<PlannedAbsencePetCarer> carers) => PlannedAbsence(
  id: 'abs-1',
  userId: 'user-1',
  startsOn: '2026-12-01',
  endsOn: '2026-12-05',
  provenance: 'user_declared',
  status: 'active',
  petIds: carers.map((c) => c.petId).toList(),
  petCarers: carers,
);

void main() {
  group('eligibleSiblingPetIds (AP-18 / R-018 matrix)', () {
    test('offers sibling where contact is carer and grant is allowed', () {
      final absence = _absence(const [
        PlannedAbsencePetCarer(
          petId: 'a',
          contactId: 'c1',
          canGrantGuestAccess: true,
        ),
        PlannedAbsencePetCarer(
          petId: 'b',
          contactId: 'c1',
          canGrantGuestAccess: true,
        ),
      ]);
      expect(
        eligibleSiblingPetIds(
          absence: absence,
          currentPetId: 'a',
          contactId: 'c1',
        ),
        ['b'],
      );
    });

    test('no offer when no other pet has the contact as carer', () {
      final absence = _absence(const [
        PlannedAbsencePetCarer(
          petId: 'a',
          contactId: 'c1',
          canGrantGuestAccess: true,
        ),
        PlannedAbsencePetCarer(
          petId: 'b',
          contactId: 'c2',
          canGrantGuestAccess: true,
        ),
      ]);
      expect(
        eligibleSiblingPetIds(
          absence: absence,
          currentPetId: 'a',
          contactId: 'c1',
        ),
        isEmpty,
      );
    });

    test('hides a sibling the viewer cannot grant for', () {
      final absence = _absence(const [
        PlannedAbsencePetCarer(
          petId: 'a',
          contactId: 'c1',
          canGrantGuestAccess: true,
        ),
        PlannedAbsencePetCarer(
          petId: 'b',
          contactId: 'c1',
          canGrantGuestAccess: false,
        ),
      ]);
      expect(
        eligibleSiblingPetIds(
          absence: absence,
          currentPetId: 'a',
          contactId: 'c1',
        ),
        isEmpty,
      );
    });
  });

  group('canSendCarerInvite', () {
    test('true when the current pet carer is saved and grant-eligible', () {
      final absence = _absence(const [
        PlannedAbsencePetCarer(
          petId: 'a',
          contactId: 'c1',
          canGrantGuestAccess: true,
        ),
      ]);
      expect(canSendCarerInvite(absence: absence, petId: 'a'), isTrue);
    });

    test('false when the current pet row is not grant-eligible', () {
      final absence = _absence(const [
        PlannedAbsencePetCarer(
          petId: 'a',
          contactId: 'c1',
          canGrantGuestAccess: false,
        ),
      ]);
      expect(canSendCarerInvite(absence: absence, petId: 'a'), isFalse);
    });

    test('false when no contact is saved on the pet', () {
      final absence = _absence(const [
        PlannedAbsencePetCarer(petId: 'a', canGrantGuestAccess: true),
      ]);
      expect(canSendCarerInvite(absence: absence, petId: 'a'), isFalse);
    });
  });

  test('model reads can_grant_guest_access and defaults to false', () {
    final on = PlannedAbsenceModel.petCarerFromJson({
      'pet_id': 'a',
      'contact_id': 'c1',
      'can_grant_guest_access': true,
    });
    final off = PlannedAbsenceModel.petCarerFromJson({'pet_id': 'b'});
    expect(on.canGrantGuestAccess, isTrue);
    expect(off.canGrantGuestAccess, isFalse);
  });

  testWidgets('offer dialog: only-this-pet returns the current pet', (
    tester,
  ) async {
    List<String>? result;
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () async {
                result = await showDialog<List<String>>(
                  context: context,
                  builder: (_) => const AwayPlanCarerInviteOfferDialog(
                    currentPetId: 'a',
                    siblingPetIds: ['b'],
                    petNamesById: {'a': 'Rex', 'b': 'Milo'},
                  ),
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('Milo'), findsOneWidget);
    await tester.tap(
      find.byKey(const Key('away_plan_carer_invite_only_this_pet')),
    );
    await tester.pumpAndSettle();
    expect(result, ['a']);
  });

  testWidgets(
    'offer dialog: include selected pets is disabled until a sibling is ticked',
    (tester) async {
      List<String>? result;
      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  result = await showDialog<List<String>>(
                    context: context,
                    builder: (_) => const AwayPlanCarerInviteOfferDialog(
                      currentPetId: 'a',
                      siblingPetIds: ['b'],
                      petNamesById: {'a': 'Rex', 'b': 'Milo'},
                    ),
                  );
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      final include = find.byKey(
        const Key('away_plan_carer_invite_include_selected'),
      );
      expect(tester.widget<FilledButton>(include).onPressed, isNull);
      await tester.tap(
        find.byKey(const Key('away_plan_carer_invite_offer_pet_b')),
      );
      await tester.pumpAndSettle();
      await tester.tap(include);
      await tester.pumpAndSettle();
      expect(result, ['a', 'b']);
    },
  );
}
