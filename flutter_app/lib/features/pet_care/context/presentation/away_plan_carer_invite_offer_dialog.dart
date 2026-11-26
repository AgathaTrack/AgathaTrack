import 'package:flutter/material.dart';

import '../../../../../l10n/app_localizations.dart';

/// AP-18 offer: the inviter chooses which eligible sibling pets join the
/// invite. Returns the pet ids to invite (current pet first), or null when
/// cancelled. Accept/decline on the invitee side is unchanged.
class AwayPlanCarerInviteOfferDialog extends StatefulWidget {
  const AwayPlanCarerInviteOfferDialog({
    super.key,
    required this.currentPetId,
    required this.siblingPetIds,
    required this.petNamesById,
  });

  final String currentPetId;
  final List<String> siblingPetIds;
  final Map<String, String> petNamesById;

  @override
  State<AwayPlanCarerInviteOfferDialog> createState() =>
      _AwayPlanCarerInviteOfferDialogState();
}

class _AwayPlanCarerInviteOfferDialogState
    extends State<AwayPlanCarerInviteOfferDialog> {
  final Set<String> _selected = {};

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return AlertDialog(
      title: Text(l.awayPlanningCarerInviteOfferTitle),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(l.awayPlanningCarerInviteOfferBody),
            const SizedBox(height: 8),
            for (final petId in widget.siblingPetIds)
              CheckboxListTile(
                key: Key('away_plan_carer_invite_offer_pet_$petId'),
                value: _selected.contains(petId),
                title: Text(widget.petNamesById[petId] ?? petId),
                controlAffinity: ListTileControlAffinity.leading,
                onChanged: (checked) => setState(() {
                  if (checked == true) {
                    _selected.add(petId);
                  } else {
                    _selected.remove(petId);
                  }
                }),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          key: const Key('away_plan_carer_invite_only_this_pet'),
          onPressed: () => Navigator.of(context).pop([widget.currentPetId]),
          child: Text(l.awayPlanningCarerInviteOnlyThisPet),
        ),
        FilledButton(
          key: const Key('away_plan_carer_invite_include_selected'),
          onPressed: _selected.isEmpty
              ? null
              : () => Navigator.of(
                  context,
                ).pop([widget.currentPetId, ..._selected]),
          child: Text(l.awayPlanningCarerInviteIncludeSelected),
        ),
      ],
    );
  }
}
