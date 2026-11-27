import { loadPlannedAbsenceOverlays } from '../../lib/care/calendar/loadPlannedAbsenceOverlays.js';

function overlayListRow(overrides = {}) {
  return {
    id: 'abs-1',
    user_id: 'user-1',
    starts_on: '2026-05-01',
    ends_on: '2026-05-10',
    title: '  Trip  ',
    is_declarer: true,
    is_co_visible: false,
    is_guest_visible: false,
    ...overrides,
  };
}

function mockOverlayPool(rows) {
  return {
    query: jest.fn(async (sql) => {
      if (sql.includes('FROM planned_absences pa')) {
        return { rows };
      }
      return { rows: [] };
    }),
  };
}

describe('care calendar planned absence overlays', () => {
  const petId = 'pet-1';
  const windowStart = '2026-05-01';
  const windowEnd = '2026-05-28';

  it('returns declarer overlay clipped to window', async () => {
    const userId = 'user-1';
    const pool = mockOverlayPool([overlayListRow()]);

    const overlays = await loadPlannedAbsenceOverlays(
      pool,
      petId,
      userId,
      windowStart,
      windowEnd,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toMatchObject({
      absence_id: 'abs-1',
      overlay_starts_on: '2026-05-01',
      overlay_ends_on: '2026-05-10',
      declarer_is_viewer: true,
      can_open_away_plan: true,
      title: 'Trip',
    });
  });

  it('clips overlay to request window when absence is wider', async () => {
    const pool = mockOverlayPool([
      overlayListRow({
        starts_on: '2026-04-20',
        ends_on: '2026-06-01',
        title: 'Long',
      }),
    ]);

    const overlays = await loadPlannedAbsenceOverlays(
      pool,
      petId,
      'user-1',
      '2026-05-10',
      windowEnd,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].overlay_starts_on).toBe('2026-05-10');
    expect(overlays[0].overlay_ends_on).toBe(windowEnd);
  });

  it('returns empty when SQL finds no overlapping absences', async () => {
    const pool = mockOverlayPool([]);

    const overlays = await loadPlannedAbsenceOverlays(
      pool,
      petId,
      'user-1',
      windowStart,
      windowEnd,
    );

    expect(overlays).toHaveLength(0);
  });

  it('guest-only handover overlay has no title and cannot open away plan', async () => {
    const pool = mockOverlayPool([
      overlayListRow({
        user_id: 'user-1',
        starts_on: '2026-05-03',
        ends_on: '2026-05-08',
        title: 'Secret',
        is_declarer: false,
        is_co_visible: false,
        is_guest_visible: true,
      }),
    ]);

    const overlays = await loadPlannedAbsenceOverlays(
      pool,
      petId,
      'guest-1',
      windowStart,
      windowEnd,
    );

    expect(overlays).toHaveLength(1);
    expect(overlays[0].can_open_away_plan).toBe(false);
    expect(overlays[0].title).toBeUndefined();
    expect(overlays[0].declarer_display_name).toBeUndefined();
  });
});