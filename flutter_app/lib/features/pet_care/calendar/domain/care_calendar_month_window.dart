import 'package:intl/intl.dart';

/// Inclusive YYYY-MM-DD window for the six-week care calendar grid (≤ 42 days).
class CareCalendarMonthWindow {
  const CareCalendarMonthWindow({required this.startsOn, required this.endsOn});

  final String startsOn;
  final String endsOn;

  static CareCalendarMonthWindow forMonth(DateTime monthAnchor) {
    final firstOfMonth = DateTime(monthAnchor.year, monthAnchor.month);
    final firstWeekday = firstOfMonth.weekday % 7;
    final gridStart = firstOfMonth.subtract(Duration(days: firstWeekday));
    final gridEnd = gridStart.add(const Duration(days: 41));
    return CareCalendarMonthWindow(
      startsOn: _toIso(gridStart),
      endsOn: _toIso(gridEnd),
    );
  }

  static String _toIso(DateTime date) => DateFormat('yyyy-MM-dd').format(date);
}