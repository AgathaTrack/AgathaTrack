import { loadPlannedAbsenceOverlays } from '../../lib/care/calendar/loadPlannedAbsenceOverlays.js';

describe('care calendar planned absence overlays', () => {
  it('returns declarer overlay clipped to window', async () => {
    const userId = 'user-1';
    const petId = 'pet-1';
    const absenceId = 'abs-1';
    const pool = {
      query: jest.fn(async (sql) => {
        if (sql.includes('FROM planned_absences pa')) {
          return {
            rows: [{
              id: absenceId,
              user_id: userId,
              starts_on: '2026-05-01',
              ends_on: '2026-05-10',
              title: '  Trip  ',
              is_declarer: true,
              is_co_visible: false,
              is_guest_visible: false,
            }],
          };
        }
        if (sql.includes('FROM planned_absences WHERE id')) {
          return {
            rows: [{
              id: absenceId,
              user_id: userId,
              status: 'active',
            }],
          };
        }
        if (sql.includes('FROM planned_absence_pets')) {
          return { rows: [{ pet_id: petId }] };
        }
        return { rows: [] };
      }),
    };

    const overlays = await loadPlannedAbsenceOverlays(
      pool,
      petId,
      userId,
      '2026-05-01',
      '2026-05-28',
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({
      absence_id: absenceId,
      overlay_starts_on: '2026-05-01',
      overlay_ends_on: '2026-05-10',
      declarer_is_viewer: true,
      can_open_away_plan: true,
      title: 'Trip',
    });
  });
});