import 'entities/care_calendar.dart';

typedef CareCalendarOverlayRef = ({
  String petId,
  CareCalendarPlannedAbsenceOverlay overlay,
});

Map<String, List<CareCalendarOverlayRef>> indexCareCalendarOverlays({
  required String petId,
  required List<CareCalendarPlannedAbsenceOverlay> overlays,
}) {
  final byDate = <String, List<CareCalendarOverlayRef>>{};
  for (final overlay in overlays) {
    var cursor = overlay.overlayStartsOn;
    while (cursor.compareTo(overlay.overlayEndsOn) <= 0) {
      final list = byDate.putIfAbsent(cursor, () => []);
      list.add((petId: petId, overlay: overlay));
      cursor = _nextIsoDay(cursor);
    }
  }
  return byDate;
}

Map<String, List<CareCalendarOverlayRef>> mergeCareCalendarOverlayMaps(
  Iterable<Map<String, List<CareCalendarOverlayRef>>> maps,
) {
  final merged = <String, List<CareCalendarOverlayRef>>{};
  for (final map in maps) {
    for (final entry in map.entries) {
      merged.putIfAbsent(entry.key, () => []).addAll(entry.value);
    }
  }
  return merged;
}

String _nextIsoDay(String iso) {
  final parts = iso.split('-').map(int.parse).toList();
  final dt = DateTime(parts[0], parts[1], parts[2]);
  final next = dt.add(const Duration(days: 1));
  final mm = next.month.toString().padLeft(2, '0');
  final dd = next.day.toString().padLeft(2, '0');
  return '${next.year}-$mm-$dd';
}