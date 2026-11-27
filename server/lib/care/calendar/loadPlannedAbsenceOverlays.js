/**
 * Planned-absence overlay facts for care calendar (D-CAL-010).
 * No away-plan projection — visibility only.
 */

import { dateToIsoDate } from '../../calendarDate.js';
import {
  loadAbsenceForViewer,
  loadDeclarerDisplayName,
  petProfileAccessSql,
} from '../absence/absenceVisibility.js';
import { GUEST_GRANT_ACTIVE } from '../../people/absenceGuestGrants.js';
import {
  PLANNED_ABSENCE_STATUS_ACTIVE,
  PLANNED_ABSENCE_STATUS_CANCELLED,
} from '../plannedAbsence.js';

/**
 * @param {string} absenceStart
 * @param {string} absenceEnd
 * @param {string} windowStart
 * @param {string} windowEnd
 */
export function clipAbsenceToCalendarWindow(absenceStart, absenceEnd, windowStart, windowEnd) {
  const overlayStarts = absenceStart > windowStart ? absenceStart : windowStart;
  const overlayEnds = absenceEnd < windowEnd ? absenceEnd : windowEnd;
  if (overlayStarts > overlayEnds) return null;
  return { overlay_starts_on: overlayStarts, overlay_ends_on: overlayEnds };
}

/**
 * @param {object} row
 * @param {string} windowStart
 * @param {string} windowEnd
 * @param {string} viewerUserId
 * @param {boolean} canOpenAwayPlan
 * @param {string|null} declarerDisplayName
 */
export function mapOverlayWireRow(
  row,
  windowStart,
  windowEnd,
  viewerUserId,
  canOpenAwayPlan,
  declarerDisplayName,
) {
  const startsOn = dateToIsoDate(row.starts_on);
  const endsOn = dateToIsoDate(row.ends_on);
  if (!startsOn || !endsOn) return null;
  const clip = clipAbsenceToCalendarWindow(startsOn, endsOn, windowStart, windowEnd);
  if (!clip) return null;

  const declarerIsViewer = row.user_id === viewerUserId;
  const rawTitle = row.title == null ? '' : String(row.title).trim();

  const wire = {
    absence_id: row.id,
    starts_on: startsOn,
    ends_on: endsOn,
    overlay_starts_on: clip.overlay_starts_on,
    overlay_ends_on: clip.overlay_ends_on,
    declarer_is_viewer: declarerIsViewer,
    can_open_away_plan: canOpenAwayPlan,
  };
  if (rawTitle) wire.title = rawTitle;
  if (!declarerIsViewer && declarerDisplayName) {
    wire.declarer_display_name = declarerDisplayName;
  }
  return wire;
}

/**
 * @param {import('pg').Pool|import('pg').PoolClient} pool
 * @param {string} petId
 * @param {string} viewerUserId
 * @param {string} startsOn
 * @param {string} endsOn
 * @returns {Promise<object[]>}
 */
export async function loadPlannedAbsenceOverlays(pool, petId, viewerUserId, startsOn, endsOn) {
  const profileSql = petProfileAccessSql('p', '$1');
  const result = await pool.query(
    `SELECT pa.id, pa.user_id, pa.starts_on, pa.ends_on, pa.title, pa.timezone
     FROM planned_absences pa
     INNER JOIN planned_absence_pets pap
       ON pap.planned_absence_id = pa.id AND pap.pet_id = $2
     INNER JOIN pets p ON p.id = pap.pet_id
     WHERE pa.status != $3
       AND pa.starts_on <= $5::date
       AND pa.ends_on >= $4::date
       AND (
         pa.user_id = $1
         OR (
           pa.user_id != $1
           AND ${profileSql}
         )
         OR EXISTS (
           SELECT 1
           FROM planned_absence_guest_grants g
           WHERE g.planned_absence_id = pa.id
             AND g.pet_id = $2
             AND g.grantee_user_id = $1
             AND g.status = $6
             AND pa.status = $7
             AND (CURRENT_TIMESTAMP AT TIME ZONE COALESCE(pa.timezone, 'UTC'))::date
                 BETWEEN pa.starts_on AND pa.ends_on
         )
       )
     ORDER BY pa.starts_on ASC`,
    [
      viewerUserId,
      petId,
      PLANNED_ABSENCE_STATUS_CANCELLED,
      startsOn,
      endsOn,
      GUEST_GRANT_ACTIVE,
      PLANNED_ABSENCE_STATUS_ACTIVE,
    ],
  );

  const overlays = [];
  for (const row of result.rows) {
    const viewed = await loadAbsenceForViewer(pool, row.id, viewerUserId);
    const canOpen =
      viewed != null && viewed.petRows.some((petRow) => petRow.pet_id === petId);

    let declarerDisplayName = null;
    if (row.user_id !== viewerUserId) {
      declarerDisplayName = await loadDeclarerDisplayName(pool, viewerUserId, row.user_id);
    }

    const wire = mapOverlayWireRow(
      row,
      startsOn,
      endsOn,
      viewerUserId,
      canOpen,
      declarerDisplayName,
    );
    if (wire) overlays.push(wire);
  }
  return overlays;
}