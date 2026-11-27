import {
  clipAbsenceToCalendarWindow,
  mapOverlayWireRow,
} from '../../lib/care/calendar/loadPlannedAbsenceOverlays.js';

describe('clipAbsenceToCalendarWindow', () => {
  it('clips partial overlap at window edges', () => {
    expect(
      clipAbsenceToCalendarWindow('2026-11-01', '2026-11-30', '2026-11-10', '2026-11-20'),
    ).toEqual({
      overlay_starts_on: '2026-11-10',
      overlay_ends_on: '2026-11-20',
    });
  });

  it('returns null when absence is outside window', () => {
    expect(
      clipAbsenceToCalendarWindow('2026-12-01', '2026-12-10', '2026-11-01', '2026-11-28'),
    ).toBeNull();
  });
});

describe('mapOverlayWireRow', () => {
  const row = {
    id: 'abs-1',
    user_id: 'user-1',
    starts_on: '2026-11-05',
    ends_on: '2026-11-15',
    title: '  Trip ',
  };

  it('omits empty title and sets declarer flags', () => {
    const wire = mapOverlayWireRow(row, '2026-11-01', '2026-11-28', 'user-1', true, null);
    expect(wire.title).toBe('Trip');
    expect(wire.declarer_is_viewer).toBe(true);
    expect(wire.declarer_display_name).toBeUndefined();
    expect(wire.overlay_starts_on).toBe('2026-11-05');
  });

  it('includes declarer name when viewer is not declarer', () => {
    const wire = mapOverlayWireRow(row, '2026-11-01', '2026-11-28', 'user-2', false, 'Alex');
    expect(wire.declarer_is_viewer).toBe(false);
    expect(wire.declarer_display_name).toBe('Alex');
  });
});