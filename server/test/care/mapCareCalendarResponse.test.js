import { mapCareCalendarResponse } from '../../lib/care/calendar/mapCareCalendarResponse.js';

describe('mapCareCalendarResponse', () => {
  const asOf = { todayIso: '2026-11-15', nowTimeIso: '12:00', timeZone: 'UTC' };

  it('marks projected slots before today as overdue', () => {
    const payload = mapCareCalendarResponse({
      petId: 'pet-1',
      startsOn: '2026-11-01',
      endsOn: '2026-11-28',
      entries: [
        {
          id: 'entry-1',
          status: 'active',
          frequency: 'once',
          next_due_date: '2026-11-10',
        },
      ],
      projection: {
        projection_status: 'complete',
        items: [
          {
            health_entry_id: 'entry-1',
            scheduled_date: '2026-11-10',
            scheduled_time: null,
            source: 'projected',
            name: 'Past projected',
            status: 'pending',
          },
        ],
        uncertainties: [],
      },
      asOf,
    });

    expect(payload.before_month.items).toHaveLength(1);
    expect(payload.before_month.items[0].display_status).toBe('overdue');
    expect(payload.days.find((d) => d.date === '2026-11-10').items).toHaveLength(0);
  });
});