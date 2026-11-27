/**
 * AP-18 / R-018 server side: explicit pet_ids on carer invites and the
 * read-only can_grant_guest_access flag on absence pet_carers[].
 */
import { createAbsenceCarerInvite } from '../../lib/people/absenceCarerInviteService.js';
import { withCanGrantGuestAccess } from '../../lib/care/awayPlan/carerGuestGrantFlags.js';

const ABSENCE = 'absence-1';
const CONTACT = 'contact-1';
const INVITER = 'user-owner';
const PET_A = 'pet-a';
const PET_B = 'pet-b';
const PET_C = 'pet-c';

/**
 * Fake pool. `ownedPets` lists pets the inviter owns (grant = true); pets
 * not listed have no grant for the inviter.
 */
function makePool({ ownedPets, petRows }) {
  const inserts = [];
  const pool = {
    inserts,
    async query(sql, params = []) {
      if (sql.startsWith('SELECT * FROM planned_absences WHERE id')) {
        return { rows: [{ id: ABSENCE, status: 'active', user_id: INVITER }] };
      }
      if (sql.includes('SELECT pet_id, contact_id FROM planned_absence_pets')) {
        return { rows: petRows };
      }
      if (sql === 'SELECT 1 FROM pets WHERE id = $1 AND user_id = $2 LIMIT 1') {
        return { rows: ownedPets.includes(params[0]) && params[1] === INVITER ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('FROM pet_access') || sql.includes('household_pets')) {
        return { rows: [] };
      }
      if (sql.includes('FROM people_contacts WHERE id = $1')) {
        return { rows: [{ id: CONTACT, email: 'carer@example.com', linked_user_id: null, inactive_at: null }] };
      }
      if (sql.includes('SELECT email FROM users WHERE id = $1')) {
        return { rows: [{ email: 'owner@example.com' }] };
      }
      if (sql.startsWith('INSERT INTO planned_absence_carer_invites')) {
        inserts.push({ kind: 'invite', params });
        return { rows: [] };
      }
      if (sql.startsWith('INSERT INTO planned_absence_carer_invite_pets')) {
        inserts.push({ kind: 'pet', params });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return pool;
}

const BOTH_CARER_ROWS = [
  { pet_id: PET_A, contact_id: CONTACT },
  { pet_id: PET_B, contact_id: CONTACT },
];

describe('carer invite with explicit pet_ids (AP-18)', () => {
  it('invites the chosen sibling pets when the inviter can grant both', async () => {
    const pool = makePool({ ownedPets: [PET_A, PET_B], petRows: BOTH_CARER_ROWS });
    const result = await createAbsenceCarerInvite(pool, {
      absenceId: ABSENCE,
      inviterUserId: INVITER,
      contactId: CONTACT,
      petIds: [PET_A, PET_B],
    });
    expect(result.status).toBe(201);
    expect(result.pet_ids.sort()).toEqual([PET_A, PET_B]);
  });

  it('invites only the current pet when pet_ids is [A]', async () => {
    const pool = makePool({ ownedPets: [PET_A, PET_B], petRows: BOTH_CARER_ROWS });
    const result = await createAbsenceCarerInvite(pool, {
      absenceId: ABSENCE,
      inviterUserId: INVITER,
      contactId: CONTACT,
      petIds: [PET_A],
    });
    expect(result.status).toBe(201);
    expect(result.pet_ids).toEqual([PET_A]);
  });

  it('returns 403 when pet_ids includes a pet the inviter cannot grant', async () => {
    const pool = makePool({ ownedPets: [PET_A], petRows: BOTH_CARER_ROWS });
    const result = await createAbsenceCarerInvite(pool, {
      absenceId: ABSENCE,
      inviterUserId: INVITER,
      contactId: CONTACT,
      petIds: [PET_A, PET_B],
    });
    expect(result).toEqual({ error: 'Forbidden', status: 403 });
    expect(pool.inserts).toHaveLength(0);
  });

  it('omitted pet_ids is all-or-nothing: 403 when any contact pet lacks a grant', async () => {
    const pool = makePool({ ownedPets: [PET_A], petRows: BOTH_CARER_ROWS });
    const result = await createAbsenceCarerInvite(pool, {
      absenceId: ABSENCE,
      inviterUserId: INVITER,
      contactId: CONTACT,
      petIds: undefined,
    });
    expect(result.status).toBe(403);
  });

  it('ignores pets the contact is not carer for (400 when none remain)', async () => {
    const pool = makePool({ ownedPets: [PET_A, PET_C], petRows: [{ pet_id: PET_A, contact_id: CONTACT }, { pet_id: PET_C, contact_id: null }] });
    const result = await createAbsenceCarerInvite(pool, {
      absenceId: ABSENCE,
      inviterUserId: INVITER,
      contactId: CONTACT,
      petIds: [PET_C],
    });
    expect(result).toEqual({ error: 'pet_ids must be absence pets covered by this contact', status: 400 });
  });
});

describe('withCanGrantGuestAccess (AP-18 eligibility hint)', () => {
  it('adds can_grant_guest_access per viewer-visible carer row', async () => {
    const pool = makePool({ ownedPets: [PET_A], petRows: [] });
    const rows = await withCanGrantGuestAccess(
      pool,
      [{ pet_id: PET_A, contact_id: CONTACT }, { pet_id: PET_B, contact_id: CONTACT }],
      INVITER,
    );
    expect(rows).toEqual([
      { pet_id: PET_A, contact_id: CONTACT, can_grant_guest_access: true },
      { pet_id: PET_B, contact_id: CONTACT, can_grant_guest_access: false },
    ]);
  });

  it('returns an empty list for no rows', async () => {
    const pool = makePool({ ownedPets: [], petRows: [] });
    await expect(withCanGrantGuestAccess(pool, [], INVITER)).resolves.toEqual([]);
  });
});
