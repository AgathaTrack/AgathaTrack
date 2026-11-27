/**
 * AP-18 / R-018: read-only UI hint per viewer-visible carer row.
 * POST …/carer-invites stays authoritative (403 when the viewer cannot grant).
 */

import { userCanGrantAbsenceGuestForPet } from '../../people/absenceGuestGrants.js';

/**
 * @param {import('pg').Pool} pool
 * @param {object[]} petCarers mapped `pet_carers[]` rows (already viewer-filtered)
 * @param {string} viewerUserId
 * @returns {Promise<object[]>} rows with `can_grant_guest_access` boolean
 */
export async function withCanGrantGuestAccess(pool, petCarers, viewerUserId) {
  const out = [];
  for (const row of petCarers || []) {
    const canGrant = await userCanGrantAbsenceGuestForPet(pool, row.pet_id, viewerUserId);
    out.push({ ...row, can_grant_guest_access: canGrant === true });
  }
  return out;
}
