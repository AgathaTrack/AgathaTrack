class CareCalendarAsOf {
  const CareCalendarAsOf({
    required this.date,
    required this.time,
    required this.timezone,
  });

  final String date;
  final String time;
  final String timezone;
}

class CareCalendarItem {
  const CareCalendarItem({
    required this.healthEntryId,
    this.occurrenceId,
    required this.scheduledDate,
    this.scheduledTime,
    required this.displayStatus,
    required this.source,
    required this.name,
    this.type,
    this.careFamily,
  });

  final String healthEntryId;
  final String? occurrenceId;
  final String scheduledDate;
  final String? scheduledTime;
  final String displayStatus;
  final String source;
  final String name;
  final String? type;
  final String? careFamily;

  bool get isProjected => source == 'projected';
  bool get isMaterialised => occurrenceId != null;
}

class CareCalendarDay {
  const CareCalendarDay({required this.date, required this.items});

  final String date;
  final List<CareCalendarItem> items;
}

class CareCalendarNotice {
  const CareCalendarNotice({required this.kind, required this.healthEntryId});

  final String kind;
  final String healthEntryId;
}

class CareCalendarResult {
  const CareCalendarResult({
    required this.petId,
    required this.asOf,
    required this.startsOn,
    required this.endsOn,
    required this.projectionStatus,
    required this.beforeMonthItems,
    required this.days,
    this.notices = const [],
  });

  final String petId;
  final CareCalendarAsOf asOf;
  final String startsOn;
  final String endsOn;
  final String projectionStatus;
  final List<CareCalendarItem> beforeMonthItems;
  final List<CareCalendarDay> days;
  final List<CareCalendarNotice> notices;
}