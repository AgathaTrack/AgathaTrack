import {
  loadScheduleDataForProjection,
  projectSchedule,
} from '../schedule/projectSchedule.js';
import { resolveCareAsOf } from '../occurrence/careAsOf.js';
import { mapCareCalendarResponse } from './mapCareCalendarResponse.js';

/**
 * @param {import('pg').Pool|import('pg').PoolClient} pool
 * @param {string} petId
 * @param {string} startsOn
 * @param {string} endsOn
 * @param {import('express').Request|null} req
 */
export async function loadCareCalendar(pool, petId, startsOn, endsOn, req) {
  const { entries, occurrencesByEntryId } = await loadScheduleDataForProjection(
    pool,
    petId,
    startsOn,
    endsOn
  );
  const asOf = await resolveCareAsOf(pool, { pet_id: petId }, req);
  const projection = projectSchedule(
    entries,
    occurrencesByEntryId,
    startsOn,
    endsOn,
    asOf.todayIso
  );
  return mapCareCalendarResponse({
    petId,
    startsOn,
    endsOn,
    projection,
    entries,
    asOf,
  });
}