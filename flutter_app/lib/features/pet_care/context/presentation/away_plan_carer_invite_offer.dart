import '../domain/entities/planned_absence.dart';

/// AP-18 / R-018 eligibility for the carer app-invite offer (UI hints only;
/// `POST …/carer-invites` stays authoritative and still returns 403).
///
/// Sibling pets are offered when [contactId] is already carer on them in the
/// same absence and the viewer can grant absence guest access for them.
List<String> eligibleSiblingPetIds({
  required PlannedAbsence absence,
  required String currentPetId,
  required String contactId,
}) {
  final ids = <String>[];
  for (final carer in absence.petCarers) {
    if (carer.petId == currentPetId) continue;
    if (carer.contactId != contactId) continue;
    if (!carer.canGrantGuestAccess) continue;
    ids.add(carer.petId);
  }
  ids.sort();
  return ids;
}

/// The send-app-invite affordance is offered only when the current pet's
/// carer row is saved with a contact and the viewer may grant guest access.
bool canSendCarerInvite({
  required PlannedAbsence absence,
  required String petId,
}) {
  for (final carer in absence.petCarers) {
    if (carer.petId != petId) continue;
    return carer.contactId != null && carer.canGrantGuestAccess;
  }
  return false;
}
