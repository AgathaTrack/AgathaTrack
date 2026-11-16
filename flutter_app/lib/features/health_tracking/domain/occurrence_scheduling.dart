import 'services/care_temporal_grouping_service.dart';
import 'care_temporal_group.dart';
import 'entities/health_occurrence.dart';

export 'occurrence_missed.dart' show isOccurrenceMissed;

enum OccurrenceZone { missed, dueToday, comingUp }

const _grouping = CareTemporalGroupingService();

OccurrenceZone occurrenceZone(HealthOccurrence occ, DateTime now) {
  final group = _grouping.groupForOccurrence(occ, now);
  return switch (group) {
    CareTemporalGroup.needsAttention => OccurrenceZone.missed,
    CareTemporalGroup.today => OccurrenceZone.dueToday,
    CareTemporalGroup.upcoming => OccurrenceZone.comingUp,
    null => OccurrenceZone.comingUp,
  };
}

/// Closest scheduled instant to present first (D-CIE-038): missed reverses asc.
int compareOccurrencesForZone(
  HealthOccurrence a,
  HealthOccurrence b,
  OccurrenceZone zone,
) {
  final dateCmp = a.scheduledDate.compareTo(b.scheduledDate);
  final timeA = a.scheduledTime ?? '00:00';
  final timeB = b.scheduledTime ?? '00:00';
  final timeCmp = timeA.compareTo(timeB);
  final asc = dateCmp != 0 ? dateCmp : timeCmp;
  if (zone == OccurrenceZone.missed) {
    return -asc;
  }
  return asc;
}

List<HealthOccurrence> sortOccurrencesByZone(
  List<HealthOccurrence> items,
  OccurrenceZone zone,
) {
  final copy = List<HealthOccurrence>.from(items);
  copy.sort((a, b) => compareOccurrencesForZone(a, b, zone));
  return copy;
}

/// Sort [items] for [zone]: closest scheduled instant to present first.
List<HealthOccurrence> sortOccurrencesClosestToPresent(
  List<HealthOccurrence> items,
  OccurrenceZone zone,
) => sortOccurrencesByZone(items, zone);
