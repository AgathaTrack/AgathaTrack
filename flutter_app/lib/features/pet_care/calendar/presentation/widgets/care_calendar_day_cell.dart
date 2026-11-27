import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'package:pet_profile_app/core/router/shell_return_navigation.dart';
import 'package:pet_profile_app/core/theme/app_color_tokens.dart';
import 'package:pet_profile_app/l10n/app_localizations.dart';
import '../../domain/entities/care_calendar.dart';

typedef CareCalendarDayMarker = ({
  String petId,
  String petName,
  CareCalendarItem item,
});

typedef CareCalendarDayOverlayRef = ({
  String petId,
  CareCalendarPlannedAbsenceOverlay overlay,
});

class CareCalendarDayCell extends StatelessWidget {
  const CareCalendarDayCell({
    super.key,
    required this.date,
    required this.markers,
    required this.overlays,
    this.defaultPetId,
  });

  final DateTime date;
  final List<CareCalendarDayMarker> markers;
  final List<CareCalendarDayOverlayRef> overlays;
  final String? defaultPetId;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    final iso = DateFormat('yyyy-MM-dd').format(date);
    final count = markers.length;
    final hasAbsenceOverlay = overlays.isNotEmpty;
    final hasProjectedOnly =
        count > 0 && markers.every((row) => row.item.isProjected);

    CareCalendarDayOverlayRef? navigableOverlay;
    if (count == 0) {
      for (final row in overlays) {
        if (row.overlay.canOpenAwayPlan) {
          navigableOverlay = row;
          break;
        }
      }
    }

    final semanticsLabel =
        hasAbsenceOverlay ? _semanticsLabel(l, count, overlays) : null;

    return Semantics(
      button: count > 0 || navigableOverlay != null,
      label: semanticsLabel,
      identifier: hasAbsenceOverlay
          ? 'care_calendar_day_${iso}_absence'
          : 'care_calendar_day_$iso',
      child: InkWell(
        onTap: count == 0
            ? navigableOverlay == null
                ? null
                : () {
                    final target = navigableOverlay!;
                    openPetAwayPlan(
                      context,
                      target.overlay.absenceId,
                      target.petId,
                    );
                  }
            : () => _onCareTap(context, iso, markers),
        child: SizedBox(
          height: 48,
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
            child: Stack(
              alignment: Alignment.center,
              children: [
                if (hasAbsenceOverlay)
                  Positioned.fill(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: AppColorTokens.awayContextSurface.withValues(
                          alpha: 0.35,
                        ),
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                  ),
                Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text(
                      '${date.day}',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                    if (count > 0)
                      Badge(
                        isLabelVisible: true,
                        backgroundColor: hasProjectedOnly
                            ? Theme.of(context).colorScheme.surfaceContainerHighest
                            : null,
                        label: Text(
                          count > 1 ? '$count' : '•',
                          style: hasProjectedOnly
                              ? Theme.of(context).textTheme.labelSmall
                              : null,
                        ),
                      )
                    else if (hasAbsenceOverlay)
                      Icon(
                        Icons.flight_takeoff,
                        size: 12,
                        color: AppColorTokens.awayContextAccent,
                        semanticLabel: l.careCalendarAbsenceDayIconSemantics,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _semanticsLabel(
    AppLocalizations l,
    int count,
    List<CareCalendarDayOverlayRef> dayOverlays,
  ) {
    final overlay = dayOverlays.first.overlay;
    if (count > 0) {
      return l.careCalendarMixedDaySemantics(count);
    }
    final titleSuffix = _titleSuffix(overlay.title);
    if (overlay.declarerIsViewer) {
      return l.careCalendarAbsenceDaySemantics(titleSuffix);
    }
    final declarerName =
        overlay.declarerDisplayName?.trim().isNotEmpty == true
        ? overlay.declarerDisplayName!.trim()
        : '—';
    return l.careCalendarAbsenceCoParentDaySemantics(declarerName, titleSuffix);
  }

  String _titleSuffix(String? title) {
    final trimmed = title?.trim();
    if (trimmed == null || trimmed.isEmpty) return '';
    return ': $trimmed';
  }

  void _onCareTap(
    BuildContext context,
    String iso,
    List<CareCalendarDayMarker> rows,
  ) {
    if (rows.length == 1 && rows.first.item.isMaterialised) {
      final item = rows.first.item;
      openOccurrenceScreen(
        context,
        petId: defaultPetId ?? rows.first.petId,
        entryId: item.healthEntryId,
        occurrenceId: item.occurrenceId!,
        source: 'care_calendar',
      );
      return;
    }
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (ctx) => CareCalendarDaySheet(
        date: iso,
        rows: rows,
        fallbackPetId: defaultPetId,
      ),
    );
  }
}

class CareCalendarDaySheet extends StatelessWidget {
  const CareCalendarDaySheet({
    super.key,
    required this.date,
    required this.rows,
    this.fallbackPetId,
  });

  final String date;
  final List<CareCalendarDayMarker> rows;
  final String? fallbackPetId;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context)!;
    return SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(l.careCalendarDaySheetTitle(date)),
          ),
          for (final row in rows)
            ListTile(
              title: Text(row.item.name),
              subtitle: Text(
                row.petName.isEmpty ? row.item.displayStatus : row.petName,
              ),
              onTap: row.item.isMaterialised
                  ? () {
                      Navigator.of(context).pop();
                      openOccurrenceScreen(
                        context,
                        petId: fallbackPetId ?? row.petId,
                        entryId: row.item.healthEntryId,
                        occurrenceId: row.item.occurrenceId!,
                        source: 'care_calendar',
                      );
                    }
                  : null,
            ),
        ],
      ),
    );
  }
}