import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'package:pet_profile_app/features/pet_profile/pet_profile.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';
import '../care_calendar_multi_pet_loader.dart' show
    careCalendarMultiPetProvider,
    careCalendarPetScopeKey;
import 'care_calendar_surface.dart';

enum CareHubViewMode { agenda, calendar }

/// Agenda + calendar toggle beside the dashboard care block (D-CAL-001).
class CareCalendarHubSection extends ConsumerStatefulWidget {
  const CareCalendarHubSection({
    super.key,
    required this.pets,
    required this.agenda,
    this.initialMode = CareHubViewMode.agenda,
  });

  final List<Pet> pets;
  final Widget agenda;
  final CareHubViewMode initialMode;

  @override
  ConsumerState<CareCalendarHubSection> createState() =>
      _CareCalendarHubSectionState();
}

class _CareCalendarHubSectionState extends ConsumerState<CareCalendarHubSection> {
  late CareHubViewMode _mode = widget.initialMode;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final livePets = widget.pets.where((p) => !p.passedAway).toList();
    final scopeKey = careCalendarPetScopeKey(
      livePets.map((p) => (id: p.id, name: p.name)).toList(growable: false),
    );
    final calendarState =
        _mode == CareHubViewMode.calendar && livePets.isNotEmpty
        ? ref.watch(careCalendarMultiPetProvider(scopeKey))
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          container: true,
          identifier: 'care_calendar_mode_toggle',
          child: SegmentedButton<CareHubViewMode>(
            segments: [
              ButtonSegment(
                value: CareHubViewMode.agenda,
                label: Text(l.careCalendarAgendaTab),
              ),
              ButtonSegment(
                value: CareHubViewMode.calendar,
                label: Text(l.careCalendarCalendarTab),
              ),
            ],
            selected: {_mode},
            onSelectionChanged: (set) {
              setState(() => _mode = set.first);
            },
          ),
        ),
        const SizedBox(height: 12),
        if (_mode == CareHubViewMode.agenda)
          widget.agenda
        else if (livePets.isEmpty)
          Text(l.careCalendarEmptyMonthBody)
        else if (calendarState == null || calendarState.isLoading)
          const SizedBox(
            height: 120,
            child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
          )
        else
          CareCalendarMultiPetSurface(
            month: calendarState.month,
            rows: calendarState.perPet,
            onPreviousMonth: () {
              final prev = DateTime(
                calendarState.month.year,
                calendarState.month.month - 1,
              );
              ref
                  .read(careCalendarMultiPetProvider(scopeKey).notifier)
                  .setMonth(prev);
            },
            onNextMonth: () {
              final next = DateTime(
                calendarState.month.year,
                calendarState.month.month + 1,
              );
              ref
                  .read(careCalendarMultiPetProvider(scopeKey).notifier)
                  .setMonth(next);
            },
            onDayTap: (_, __) {},
          ),
      ],
    );
  }
}