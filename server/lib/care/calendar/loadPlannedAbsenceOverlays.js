/**
 * Planned-absence overlay facts for care-calendar (D-CAL-010).
 * Absence visibility only — no away-plan projection passthrough.
 */

import { dateToIsoDate } from '../../calendarDate.js';
import {
  loadAbsenceForViewer,
  loadDeclarerDisplayName,
  petProfileAccessSql,
} from '../absence/absenceVisibility.js';
import {
  PLANNED_ABSENCE_STATUS_ACTIVE,
  PLANNED_ABSENCE_STATUS_CANCELLED,
} from '../plannedAbsence.js';
import { GUEST_GRANT_ACTIVE } from '../../people/absenceGuestGrants.js';

/**
 * @param {string} absenceStart YYYY-MM-DD
 * @param {string} absenceEnd YYYY-MM-DD
 * @param {string} windowStart YYYY-MM-DD
 * @param {string} windowEnd YYYY-MM-DD
 */
function clipToWindow(absenceStart, absenceEnd, windowStart, windowEnd) {
  const overlayStartsOn = absenceStart > windowStart ? absenceStart : windowStart;
  const overlayEndsOn = absenceEnd < windowEnd ? absenceEnd : windowEnd;
  if (overlayStartsOn > overlayEndsOn) return null;
  return { overlay_starts_on: overlayStartsOn, overlay_ends_on: overlayEndsOn };
}

/**
 * @param {string|null|undefined} raw
 */
function wireTitle(raw) {
  if (raw == null) return undefined;
  const text = String(raw).trim();
  return text === '' ? undefined : text;
}

/**
 * @param {import('pg').Pool|import('pg').PoolClient} pool
 * @param {string} petId
 * @param {string} viewerUserId
 * @param {string} startsOn
 * @param {string} endsOn
 */
export async function loadPlannedAbsenceOverlays(
  pool,
  petId,
  viewerUserId,
  startsOn,
  endsOn,
) {
  const profileSql = petProfileAccessSql('p', '$2');
  const guestHandoverTodaySql = `(CURRENT_TIMESTAMP AT TIME ZONE COALESCE(pa.timezone, 'UTC'))::date
      BETWEEN pa.starts_on AND pa.ends_on`;
  const result = await pool.query(
    `SELECT pa.id, pa.user_id, pa.starts_on, pa.ends_on, pa.title,
            (pa.user_id = $2) AS is_declarer,
            (pa.user_id != $2 AND ${profileSql}) AS is_co_visible,
            EXISTS (
              SELECT 1
              FROM planned_absence_guest_grants g
              WHERE g.planned_absence_id = pa.id
                AND g.pet_id = $1
                AND g.grantee_user_id = $2
                AND g.status = $6
                AND pa.status = $7
                AND ${guestHandoverTodaySql}
            ) AS is_guest_visible
     FROM planned_absences pa
     INNER JOIN planned_absence_pets pap
       ON pap.planned_absence_id = pa.id AND pap.pet_id = $1
     INNER JOIN pets p ON p.id = pap.pet_id
     WHERE pa.status != $3
       AND pa.ends_on >= $4::date
       AND pa.starts_on <= $5::date
       AND (
         pa.user_id = $2
         OR (pa.user_id != $2 AND ${profileSql})
         OR EXISTS (
              SELECT 1
              FROM planned_absence_guest_grants g
              WHERE g.planned_absence_id = pa.id
                AND g.pet_id = $1
                AND g.grantee_user_id = $2
                AND g.status = $6
                AND pa.status = $7
                AND ${guestHandoverTodaySql}
            )
       )
     ORDER BY pa.starts_on ASC`,
  [
    petId,
    viewerUserId,
    PLANNED_ABSENCE_STATUS_CANCELLED,
    startsOn,
    endsOn,
    GUEST_GRANT_ACTIVE,
    PLANNED_ABSENCE_STATUS_ACTIVE,
  ],
  );

  const overlays = [];
  for (const row of result.rows) {
    const starts = dateToIsoDate(row.starts_on);
    const ends = dateToIsoDate(row.ends_on);
    if (!starts || !ends) continue;
    const clip = clipToWindow(starts, ends, startsOn, endsOn);
    if (!clip) continue;

    const declarerIsViewer = row.is_declarer === true;
    const isGuestOnly =
      row.is_guest_visible === true
      && !declarerIsViewer
      && row.is_co_visible !== true;

    /** @type {Record<string, unknown>} */
    const overlay = {
      absence_id: row.id,
      starts_on: starts,
      ends_on: ends,
      ...clip,
      declarer_is_viewer: declarerIsViewer,
      can_open_away_plan: false,
    };

    if (!isGuestOnly) {
      const title = wireTitle(row.title);
      if (title !== undefined) overlay.title = title;
      if (!declarerIsViewer) {
        const name = await loadDeclarerDisplayName(pool, viewerUserId, row.user_id);
        if (name) overlay.declarer_display_name = name;
      }
      if (declarerIsViewer) {
        overlay.can_open_away_plan = true;
      } else {
        const viewed = await loadAbsenceForViewer(pool, row.id, viewerUserId);
        overlay.can_open_away_plan = Boolean(
          viewed?.petRows?.some((pr) => pr.pet_id === petId),
        );
      }
    }

    overlays.push(overlay);
  }
  return overlays;
}