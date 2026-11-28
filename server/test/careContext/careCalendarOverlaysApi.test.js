import request from 'supertest';

import { createApp } from '../../bin/server.js';
import { addCalendarDaysIso } from '../../lib/calendarDate.js';
import { wallClockInTimeZone } from '../../lib/petHomeTimezone.js';
import { createMockPool, petId, token, userId } from '../pets/helpers.js';

function authHeader() {
  return { Authorization: `Bearer ${token}` };
}

describe('care calendar planned absence overlays API', () => {
  let today;
  let startsOn;
  let endsOn;

  beforeEach(() => {
    today = wallClockInTimeZone('UTC').todayIso;
    startsOn = today;
    endsOn = addCalendarDaysIso(today, 10);
  });

  it('includes declarer-owned absence clipped to the request window', async () => {
    const app = createApp(
      createMockPool(async (sql) => {
        if (sql.includes('FROM planned_absences pa')) {
          return {
            rows: [{
              id: 'abs-1',
              user_id: userId,
              starts_on: startsOn,
              ends_on: endsOn,
              title: ' Away ',
            }],
          };
        }
        if (sql.includes('FROM pets WHERE id')) {
          return { rows: [{ id: petId, user_id: userId, home_timezone: 'UTC' }] };
        }
        if (sql.includes('FROM pet_access')) {
          return { rows: [{ pet_id: petId, user_id: userId }] };
        }
        if (sql.includes('SELECT timezone FROM users')) {
          return { rows: [{ timezone: 'UTC' }] };
        }
        if (sql.includes('FROM pets WHERE id = $1 AND user_id = $2')) {
          return { rows: [{ id: petId }] };
        }
        if (sql.includes('FROM care_items')) return { rows: [] };
        return { rows: [] };
      }),
    );

    const res = await request(app)
      .get(`/api/pets/${petId}/care-calendar?starts_on=${startsOn}&ends_on=${endsOn}`)
      .set(authHeader());

    expect(res.statusCode).toBe(200);
    expect(res.body.planned_absence_overlays).toHaveLength(1);
    expect(res.body.planned_absence_overlays[0]).toMatchObject({
      absence_id: 'abs-1',
      overlay_starts_on: startsOn,
      overlay_ends_on: endsOn,
      declarer_is_viewer: true,
      can_open_away_plan: true,
      title: 'Away',
    });
  });

  it('omits cancelled absences from the overlay query', async () => {
    const app = createApp(
      createMockPool(async (sql) => {
        if (sql.includes('FROM planned_absences pa')) {
          expect(sql).toContain('pa.status !=');
          return { rows: [] };
        }
        if (sql.includes('FROM pets WHERE id')) {
          return { rows: [{ id: petId, user_id: userId, home_timezone: 'UTC' }] };
        }
        if (sql.includes('FROM pet_access')) {
          return { rows: [{ pet_id: petId, user_id: userId }] };
        }
        if (sql.includes('SELECT timezone FROM users')) {
          return { rows: [{ timezone: 'UTC' }] };
        }
        if (sql.includes('FROM care_items')) return { rows: [] };
        return { rows: [] };
      }),
    );

    const res = await request(app)
      .get(`/api/pets/${petId}/care-calendar?starts_on=${startsOn}&ends_on=${endsOn}`)
      .set(authHeader());

    expect(res.statusCode).toBe(200);
    expect(res.body.planned_absence_overlays).toEqual([]);
  });
});