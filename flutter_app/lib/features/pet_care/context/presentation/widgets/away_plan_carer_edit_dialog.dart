import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../../l10n/app_localizations.dart';
import '../../../../people/people.dart';
import '../../data/datasources/care_context_remote_datasource.dart';
import '../../domain/entities/planned_absence_pet_carer.dart';
import '../away_plan_carer_invite_offer.dart';
import '../away_plan_carer_invite_offer_dialog.dart';
import '../providers/care_context_providers.dart';

/// Per-pet carer editor — assigns a directory contact (People phase 2).
class AwayPlanCarerEditDialog extends ConsumerStatefulWidget {
  const AwayPlanCarerEditDialog({
    super.key,
    required this.absenceId,
    required this.petId,
    required this.petName,
    required this.currentCarer,
    this.petNamesById = const {},
  });

  final String absenceId;
  final String petId;
  final String petName;
  final PlannedAbsencePetCarer currentCarer;

  /// Names for sibling pets listed in the AP-18 invite offer.
  final Map<String, String> petNamesById;

  @override
  ConsumerState<AwayPlanCarerEditDialog> createState() =>
      _AwayPlanCarerEditDialogState();
}

class _AwayPlanCarerEditDialogState
    extends ConsumerState<AwayPlanCarerEditDialog> {
  String? _selectedContactId;
  late final TextEditingController _petNoteController;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _selectedContactId = widget.currentCarer.contactId;
    _petNoteController = TextEditingController(
      text: widget.currentCarer.petNote ?? '',
    );
  }

  @override
  void dispose() {
    _petNoteController.dispose();
    super.dispose();
  }

  bool get _canSave {
    if (_selectedContactId != null && _selectedContactId!.isNotEmpty) {
      return true;
    }
    return widget.currentCarer.contactId != null;
  }

  String? get _normalizedPetNote =>
      _petNoteController.text.trim().isEmpty ? null : _petNoteController.text;

  Map<String, dynamic> _payload() {
    final body = <String, dynamic>{'pet_note': _normalizedPetNote};
    if (_selectedContactId != widget.currentCarer.contactId) {
      body['contact_id'] = _selectedContactId;
    }
    return body;
  }

  Future<void> _save() async {
    final l = AppLocalizations.of(context)!;
    setState(() => _saving = true);
    try {
      await ref
          .read(careContextRepositoryProvider)
          .patchPerPetAwayPlan(
            absenceId: widget.absenceId,
            petId: widget.petId,
            body: _payload(),
          );
      if (!mounted) return;
      ref.invalidate(plannedAbsenceDetailProvider(widget.absenceId));
      ref.invalidate(awayPlanReadinessProvider(widget.absenceId));
      ref.invalidate(
        perPetAwayPlanStatusProvider((
          absenceId: widget.absenceId,
          petId: widget.petId,
        )),
      );
      Navigator.of(context).pop(true);
    } on CareContextApiException catch (err) {
      if (!mounted) return;
      if (err.statusCode == 403) {
        ref.invalidate(rosterProvider);
        _showFailure(l.awayPlanningCarerEditSaveFailedForbidden);
      } else {
        _showFailure(l.awayPlanningCarerEditSaveFailed);
      }
    } catch (_) {
      _showFailure(l.awayPlanningCarerEditSaveFailed);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  /// Whether the saved carer on this pet can receive an app invite from here.
  bool get _showInviteAction {
    final saved = widget.currentCarer.contactId;
    return saved != null &&
        _selectedContactId == saved &&
        widget.currentCarer.canGrantGuestAccess;
  }

  /// AP-18: re-read the absence (fresh carer rows), offer eligible sibling
  /// pets, then send one invite with explicit `pet_ids`.
  Future<void> _sendInvite() async {
    final l = AppLocalizations.of(context)!;
    final contactId = widget.currentCarer.contactId;
    if (contactId == null) return;
    setState(() => _saving = true);
    try {
      final absence = await ref.refresh(
        plannedAbsenceDetailProvider(widget.absenceId).future,
      );
      if (!mounted) return;
      if (!canSendCarerInvite(absence: absence, petId: widget.petId)) {
        _showFailure(l.awayPlanningCarerInviteFailed);
        return;
      }
      var petIds = [widget.petId];
      final siblings = eligibleSiblingPetIds(
        absence: absence,
        currentPetId: widget.petId,
        contactId: contactId,
      );
      if (siblings.isNotEmpty) {
        final chosen = await showDialog<List<String>>(
          context: context,
          builder: (_) => AwayPlanCarerInviteOfferDialog(
            currentPetId: widget.petId,
            siblingPetIds: siblings,
            petNamesById: widget.petNamesById,
          ),
        );
        if (!mounted || chosen == null) return;
        petIds = chosen;
      }
      await ref
          .read(careContextRepositoryProvider)
          .createAbsenceCarerInvite(
            absenceId: widget.absenceId,
            contactId: contactId,
            petIds: petIds,
          );
      if (!mounted) return;
      _showMessage(l.awayPlanningCarerInviteSent);
    } catch (_) {
      _showFailure(l.awayPlanningCarerInviteFailed);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  void _showFailure(String message) => _showMessage(message);

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final selected = _selectedContactId == null
        ? null
        : ref.watch(personSummaryProvider(_selectedContactId!));

    return AlertDialog(
      title: Text(l.awayPlanningCarerEditTitle(widget.petName)),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            PeoplePickerField(
              purpose: 'away_plan_carer',
              query: PeopleQuery(
                groups: const {ContactGroup.carer},
                includeHouseholdMembers: true,
                allowNone: true,
                currentId: widget.currentCarer.contactId,
              ),
              value: selected,
              placeholder: l.awayPlanningCarerEditContactsEmpty,
              quickAddGroup: ContactGroup.carer,
              onChanged: (PeoplePickerResult? result) {
                switch (result) {
                  case PeoplePickerContactResult(:final contact):
                    setState(() => _selectedContactId = contact.id);
                  case PeoplePickerNoneResult():
                    setState(() => _selectedContactId = null);
                  case null:
                  case PeoplePickerTypedNameResult():
                    break;
                }
              },
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TextField(
                key: const Key('away_plan_carer_pet_note'),
                controller: _petNoteController,
                decoration: InputDecoration(
                  labelText: l.awayPlanningCarerEditPetNoteLabel(
                    widget.petName,
                  ),
                ),
                textCapitalization: TextCapitalization.sentences,
                minLines: 2,
                maxLines: 4,
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('away_plan_carer_edit_cancel'),
          onPressed: _saving ? null : () => Navigator.of(context).pop(false),
          child: Text(l.cancel),
        ),
        if (_showInviteAction)
          TextButton(
            key: const Key('away_plan_carer_send_invite'),
            onPressed: _saving ? null : _sendInvite,
            child: Text(l.awayPlanningCarerInviteSendAction),
          ),
        FilledButton(
          key: const Key('away_plan_carer_edit_save'),
          onPressed: (_saving || !_canSave) ? null : _save,
          child: _saving
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(l.awayPlanningCarerEditSaveAction),
        ),
      ],
    );
  }
}
