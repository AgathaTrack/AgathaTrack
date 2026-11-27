import '../../domain/entities/care_calendar.dart';

class CareCalendarModel {
  static CareCalendarResult fromJson(Map<String, dynamic> json) {
    final asOfJson = json['as_of'] as Map<String, dynamic>? ?? {};
    final beforeJson = json['before_month'] as Map<String, dynamic>? ?? {};
    final dayList = (json['days'] as List<dynamic>? ?? [])
        .cast<Map<String, dynamic>>();
    final noticeList = (json['notices'] as List<dynamic>? ?? [])
        .cast<Map<String, dynamic>>();
    final overlayList = (json['planned_absence_overlays'] as List<dynamic>? ?? [])
        .cast<Map<String, dynamic>>();

    return CareCalendarResult(
      petId: json['pet_id'] as String? ?? '',
      asOf: CareCalendarAsOf(
        date: asOfJson['date'] as String? ?? '',
        time: asOfJson['time'] as String? ?? '',
        timezone: asOfJson['timezone'] as String? ?? 'UTC',
      ),
      startsOn: json['starts_on'] as String? ?? '',
      endsOn: json['ends_on'] as String? ?? '',
      projectionStatus: json['projection_status'] as String? ?? 'complete',
      beforeMonthItems: _items(beforeJson['items']),
      days: dayList
          .map(
            (d) => CareCalendarDay(
              date: d['date'] as String? ?? '',
              items: _items(d['items']),
            ),
          )
          .toList(growable: false),
      notices: noticeList
          .map(
            (n) => CareCalendarNotice(
              kind: n['kind'] as String? ?? '',
              healthEntryId: n['health_entry_id'] as String? ?? '',
            ),
          )
          .toList(growable: false),
      plannedAbsenceOverlays: overlayList
          .map(
            (o) => CareCalendarPlannedAbsenceOverlay(
              absenceId: o['absence_id'] as String? ?? '',
              startsOn: o['starts_on'] as String? ?? '',
              endsOn: o['ends_on'] as String? ?? '',
              overlayStartsOn: o['overlay_starts_on'] as String? ?? '',
              overlayEndsOn: o['overlay_ends_on'] as String? ?? '',
              declarerIsViewer: o['declarer_is_viewer'] as bool? ?? false,
              canOpenAwayPlan: o['can_open_away_plan'] as bool? ?? false,
              title: o['title'] as String?,
              declarerDisplayName: o['declarer_display_name'] as String?,
            ),
          )
          .toList(growable: false),
    );
  }

  static List<CareCalendarItem> _items(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .cast<Map<String, dynamic>>()
        .map(
          (item) => CareCalendarItem(
            healthEntryId: item['health_entry_id'] as String? ?? '',
            occurrenceId: item['occurrence_id'] as String?,
            scheduledDate: item['scheduled_date'] as String? ?? '',
            scheduledTime: item['scheduled_time'] as String?,
            displayStatus: item['display_status'] as String? ?? 'coming_up',
            source: item['source'] as String? ?? 'projected',
            name: item['name'] as String? ?? '',
            type: item['type'] as String?,
            careFamily: item['care_family'] as String?,
          ),
        )
        .toList(growable: false);
  }
}
