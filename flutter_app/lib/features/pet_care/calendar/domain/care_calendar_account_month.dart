import 'package:pet_profile_app/core/utils/calendar_date.dart';

/// Derives the visible calendar month from the API `as_of.date` (account TZ).
DateTime? careCalendarMonthFromAsOf(String asOfDate) {
  final parsed = parseCalendarDate(asOfDate);
  if (parsed == null) return null;
  return DateTime(parsed.year, parsed.month);
}