/**
 * Care calendar query window (D-CAL-002) — distinct from planned-absence horizon.
 */

import {
  addCalendarDaysIso,
  normalizeCalendarDateInput,
} from '../../calendarDate.js';
import { PLANNED_ABSENCE_MAX_HORIZON_DAYS } from '../plannedAbsence.js';

export const CARE_CALENDAR_MAX_INCLUSIVE_DAYS = 42;
export const CARE_CALENDAR_STARTS_ON_FLOOR_DAYS = 70;

/**
 * Inclusive calendar-day span between two YYYY-MM-DD values.
 *
 * @param {string} startsOn
 * @param {string} endsOn
 * @returns {number}
 */
export function inclusiveCalendarSpanDays(startsOn, endsOn) {
  const [sy, sm, sd] = startsOn.split('-').map(Number);
  const [ey, em, ed] = endsOn.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.floor((end - start) / 86400000) + 1;
}

/**
 * @param {string|null|undefined} startsOn
 * @param {string|null|undefined} endsOn
 * @param {string} accountTodayIso users.timezone "today" for chrome caps
 * @returns {{ ok: true, starts_on: string, ends_on: string } | { ok: false, error: string, code: string }}
 */
export function validateCareCalendarWindow(startsOn, endsOn, accountTodayIso) {
  const starts = normalizeCalendarDateInput(startsOn);
  const ends = normalizeCalendarDateInput(endsOn);
  if (!starts || !ends) {
    return {
      ok: false,
      code: 'care_calendar_window_required',
      error: 'starts_on and ends_on are required calendar dates (YYYY-MM-DD)',
    };
  }
  if (ends < starts) {
    return {
      ok: false,
      code: 'care_calendar_window_order',
      error: 'ends_on must be on or after starts_on',
    };
  }
  const span = inclusiveCalendarSpanDays(starts, ends);
  if (span > CARE_CALENDAR_MAX_INCLUSIVE_DAYS) {
    return {
      ok: false,
      code: 'care_calendar_window_span',
      error: `Calendar window may span at most ${CARE_CALENDAR_MAX_INCLUSIVE_DAYS} inclusive days`,
    };
  }
  const minStart = addCalendarDaysIso(accountTodayIso, -CARE_CALENDAR_STARTS_ON_FLOOR_DAYS);
  if (starts < minStart) {
    return {
      ok: false,
      code: 'care_calendar_window_past_floor',
      error: 'starts_on is before the earliest allowed calendar month',
    };
  }
  const maxEnd = addCalendarDaysIso(accountTodayIso, PLANNED_ABSENCE_MAX_HORIZON_DAYS);
  if (ends > maxEnd) {
    return {
      ok: false,
      code: 'care_calendar_window_forward_cap',
      error: 'ends_on exceeds the maximum forward calendar horizon',
    };
  }
  return { ok: true, starts_on: starts, ends_on: ends };
}