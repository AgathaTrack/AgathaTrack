/**
 * Care calendar read DTO (D-CAL-003) — raw projectSchedule output, not away-plan contract.
 */

import { isEntrySeriesClosed } from '../item/seriesLifecycle.js';
import { isItemClosed, CARE_ITEM_STATUS_PAUSED } from '../item/itemStatus.js';
import { occurrenceStatus, OCCURRENCE_STATUS_OVERDUE } from '../schedule/occurrenceStatus.js';
import { asOfToWire } from '../occurrence/careAsOf.js';
import {
  UNCERTAINTY_REASON_FROM_COMPLETION_CHAIN,
  UNCERTAINTY_REASON_FROM_COMPLETION_PENDING,
} from '../schedule/projectSchedule.js';

const DONE_STATUSES = new Set(['done', 'skipped', 'completed']);

/**
 * @param {object} entry
 * @param {string} todayIso
 */
function entryVisibleOnCalendar(entry, todayIso) {
  const status = entry.status || 'active';
  if (status === CARE_ITEM_STATUS_PAUSED || isItemClosed(entry)) return false;
  if (isEntrySeriesClosed(entry, todayIso)) return false;
  return true;
}

/**
 * @param {object} rawItem from projectSchedule
 */
function isOpenOccurrenceRow(rawItem) {
  if (rawItem.source !== 'materialised') return true;
  const st = (rawItem.status || 'pending').toLowerCase();
  return !DONE_STATUSES.has(st);
}

/**
 * @param {object} rawItem
 * @param {object} entry
 * @param {{ todayIso: string, nowTimeIso: string, timeZone: string }} asOf
 */
function wireCalendarItem(rawItem, entry, asOf) {
  const occurrence = rawItem.occurrence_id
    ? {
        id: rawItem.occurrence_id,
        scheduled_date: rawItem.scheduled_date,
        scheduled_time: rawItem.scheduled_time,
        status: rawItem.status || 'pending',
        origin: rawItem.source === 'materialised' ? 'schedule' : 'computed',
      }
    : {
        id: null,
        scheduled_date: rawItem.scheduled_date,
        scheduled_time: rawItem.scheduled_time,
        status: 'pending',
        origin: 'computed',
      };
  const displayStatus = rawItem.source === 'materialised'
    ? occurrenceStatus({ occurrence, entry, asOf })
    : rawItem.scheduled_date < asOf.todayIso
      ? OCCURRENCE_STATUS_OVERDUE
      : 'coming_up';

  return {
    health_entry_id: rawItem.health_entry_id,
    occurrence_id: rawItem.occurrence_id,
    scheduled_date: rawItem.scheduled_date,
    scheduled_time: rawItem.scheduled_time,
    display_status: displayStatus,
    source: rawItem.source,
    certainty: rawItem.certainty,
    name: rawItem.name,
    type: rawItem.type,
    care_family: rawItem.care_family,
  };
}

/**
 * @param {object[]} uncertainties
 */
function buildMonthNotices(uncertainties) {
  const notices = [];
  for (const u of uncertainties) {
    if (u.reason === UNCERTAINTY_REASON_FROM_COMPLETION_PENDING) {
      notices.push({ kind: 'from_completion_pending', health_entry_id: u.health_entry_id });
    } else if (u.reason === UNCERTAINTY_REASON_FROM_COMPLETION_CHAIN) {
      notices.push({ kind: 'from_completion_chain', health_entry_id: u.health_entry_id });
    }
  }
  return notices.length ? notices : undefined;
}

/**
 * @param {string} startsOn
 * @param {string} endsOn
 */
function emptyDayBuckets(startsOn, endsOn) {
  const days = [];
  let cursor = startsOn;
  while (cursor <= endsOn) {
    days.push({ date: cursor, items: [] });
    const [y, m, d] = cursor.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + 1);
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    cursor = `${yy}-${mm}-${dd}`;
  }
  return days;
}

/**
 * @param {{
 *   petId: string,
 *   startsOn: string,
 *   endsOn: string,
 *   projection: import('../schedule/projectSchedule.js').projectSchedule extends Function ? ReturnType<import('../schedule/projectSchedule.js').projectSchedule> : object,
 *   entries: object[],
 *   asOf: { todayIso: string, nowTimeIso: string, timeZone: string },
 * }} input
 */
export function mapCareCalendarResponse({ petId, startsOn, endsOn, projection, entries, asOf }) {
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const beforeMonth = [];
  const byDate = new Map();

  for (const raw of projection.items || []) {
    const entry = entryById.get(raw.health_entry_id);
    if (!entry || !entryVisibleOnCalendar(entry, asOf.todayIso)) continue;
    if (!isOpenOccurrenceRow(raw)) continue;

    const wired = wireCalendarItem(raw, entry, asOf);
    const inWindow = raw.scheduled_date >= startsOn && raw.scheduled_date <= endsOn;

    if (!inWindow) {
      if (wired.display_status === OCCURRENCE_STATUS_OVERDUE && raw.scheduled_date < startsOn) {
        beforeMonth.push(wired);
      }
      continue;
    }

    if (wired.display_status === OCCURRENCE_STATUS_OVERDUE) {
      beforeMonth.push(wired);
      continue;
    }

    const list = byDate.get(raw.scheduled_date) || [];
    list.push(wired);
    byDate.set(raw.scheduled_date, list);
  }

  const days = emptyDayBuckets(startsOn, endsOn).map((day) => ({
    date: day.date,
    items: (byDate.get(day.date) || []).sort((a, b) => {
      const ta = a.scheduled_time || '';
      const tb = b.scheduled_time || '';
      if (ta !== tb) return ta.localeCompare(tb);
      return (a.name || '').localeCompare(b.name || '');
    }),
  }));

  beforeMonth.sort((a, b) => {
    if (a.scheduled_date !== b.scheduled_date) {
      return a.scheduled_date.localeCompare(b.scheduled_date);
    }
    const ta = a.scheduled_time || '';
    const tb = b.scheduled_time || '';
    return ta.localeCompare(tb);
  });

  return {
    pet_id: petId,
    as_of: asOfToWire(asOf),
    starts_on: startsOn,
    ends_on: endsOn,
    projection_status: projection.projection_status,
    before_month: { items: beforeMonth },
    days,
    notices: buildMonthNotices(projection.uncertainties || []),
  };
}