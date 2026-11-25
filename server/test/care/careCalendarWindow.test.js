import {
  CARE_CALENDAR_MAX_INCLUSIVE_DAYS,
  inclusiveCalendarSpanDays,
  validateCareCalendarWindow,
} from '../../lib/care/calendar/validateCareCalendarWindow.js';
import { addCalendarDaysIso, todayCalendarIso } from '../../lib/calendarDate.js';

describe('validateCareCalendarWindow', () => {
  const today = todayCalendarIso();

  it('requires starts_on and ends_on', () => {
    const result = validateCareCalendarWindow(null, null, today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('care_calendar_window_required');
  });

  it('rejects ends before starts', () => {
    const result = validateCareCalendarWindow('2026-08-10', '2026-08-01', today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('care_calendar_window_order');
  });

  it('rejects span longer than 42 inclusive days', () => {
    const starts = today;
    const ends = addCalendarDaysIso(today, CARE_CALENDAR_MAX_INCLUSIVE_DAYS);
    expect(inclusiveCalendarSpanDays(starts, ends)).toBe(CARE_CALENDAR_MAX_INCLUSIVE_DAYS + 1);
    const result = validateCareCalendarWindow(starts, ends, today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('care_calendar_window_span');
  });

  it('accepts 42 inclusive days', () => {
    const starts = today;
    const ends = addCalendarDaysIso(today, CARE_CALENDAR_MAX_INCLUSIVE_DAYS - 1);
    expect(inclusiveCalendarSpanDays(starts, ends)).toBe(CARE_CALENDAR_MAX_INCLUSIVE_DAYS);
    const result = validateCareCalendarWindow(starts, ends, today);
    expect(result.ok).toBe(true);
  });

  it('rejects starts_on before account today minus 70 days', () => {
    const starts = addCalendarDaysIso(today, -71);
    const ends = addCalendarDaysIso(today, -30);
    const result = validateCareCalendarWindow(starts, ends, today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('care_calendar_window_past_floor');
  });

  it('rejects ends_on beyond forward cap', () => {
    const starts = addCalendarDaysIso(today, 330);
    const ends = addCalendarDaysIso(today, 367);
    const result = validateCareCalendarWindow(starts, ends, today);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('care_calendar_window_forward_cap');
  });
});