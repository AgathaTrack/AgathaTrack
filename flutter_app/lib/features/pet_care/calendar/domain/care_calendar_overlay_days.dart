import 'entities/care_calendar.dart';

/// Maps each in-grid calendar day to overlays active on that date (inclusive).
Map<String, List<CareCalendarPlannedAbsenceOverlay>> plannedAbsenceOverlaysByDay(
  List<CareCalendarPlannedAbsenceOverlay> overlays,
) {
  final byDay = <String, List<CareCalendarPlannedAbsenceOverlay>>{};
  for (final overlay in overlays) {
    var cursor = overlay.overlayStartsOn;
    while (cursor.compareTo(overlay.overlayEndsOn) <= 0) {
      final list = byDay.putIfAbsent(cursor, () => []);
      if (!list.any((o) => o.absenceId == overlay.absenceId)) {
        list.add(overlay);
      }
      cursor = _nextCalendarDay(cursor);
    }
  }
  return byDay;
}

String _nextCalendarDay(String iso) {
  final parts = iso.split('-');
  final year = int.parse(parts[0]);
  final month = int.parse(parts[1]);
  final day = int.parse(parts[2]);
  final dt = DateTime(year, month, day).add(const Duration(days: 1));
  final m = dt.month.toString().padLeft(2, '0');
  final d = dt.day.toString().padLeft(2, '0');
  return '${dt.year}-$m-$d';
}