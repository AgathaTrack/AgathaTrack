import 'health_history_entry.dart';

/// A single scheduled dose instant for a [HealthEntry] series.
class HealthOccurrence {
  const HealthOccurrence({
    required this.id,
    required this.entryId,
    required this.scheduledDate,
    this.scheduledTime,
    required this.status,
    this.completedOn,
    this.markedAt,
    this.markedByUserId,
    this.markedByName,
    this.notes = '',
    this.missed = false,
    this.outcome,
    this.linkedWeight,
  });

  final String id;
  final String entryId;

  /// Calendar day (`YYYY-MM-DD` wire).
  final DateTime scheduledDate;

  /// Local wall-clock `HH:mm`, or null for all-day.
  final String? scheduledTime;

  /// Stored status: `pending`, `completed`, `skipped`, or `not_recorded`.
  final String status;

  /// Wire outcome when present (`done`, `skipped`, `not_recorded`, `open`).
  final String? outcome;

  final DateTime? completedOn;
  final DateTime? markedAt;
  final String? markedByUserId;
  final String? markedByName;
  final String notes;

  /// Server authority in pet home TZ when listing open occurrences; client
  /// recomputes only when the API omitted `missed`.
  final bool missed;

  /// Completed weigh-in weight when the past-occurrence list includes it.
  final HealthHistoryLinkedWeight? linkedWeight;

  bool get isPending => status == 'pending';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is HealthOccurrence &&
          runtimeType == other.runtimeType &&
          id == other.id;

  @override
  int get hashCode => id.hashCode;
}
