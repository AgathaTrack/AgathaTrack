import request from 'supertest';

import { createApp } from '../../bin/server.js';
import { addCalendarDaysIso, todayCalendarIso } from '../../lib/calendarDate.js';
import { createMockPool, petId, token, userId } from '../pets/helpers.js';

function authHeader() {
  return { Authorization: `Bearer ${token}` };
}

describe('care calendar API', () => {
  const today = todayCalendarIso();
  const startsOn = today;
  const endsOn = addCalendarDaysIso(today, 27);

  function createTestApp(handler) {
    return createApp(createMockPool(handler));
  }

  it('GET returns 401 without auth', async () => {
    const app = createTestApp(async () => ({ rows: [] }));
    const res = await request(app).get(
      `/api/pets/${petId}/care-calendar?starts_on=${startsOn}&ends_on=${endsOn}`
    );
    expect(res.statusCode).toBe(401);
  });

  it('GET returns 400 for span over 42 days', async () => {
    const app = createTestApp(async (sql) => {
      if (sql.includes('hasPetCapability') || sql.includes('FROM pets')) {
        return { rows: [{ id: petId }] };
      }
      if (sql.includes('SELECT timezone FROM users')) {
        return { rows: [{ timezone: 'UTC' }] };
      }
      return { rows: [] };
    });
    const tooFar = addCalendarDaysIso(today, 50);
    const res = await request(app)
      .get(`/api/pets/${petId}/care-calendar?starts_on=${today}&ends_on=${tooFar}`)
      .set(authHeader());
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('care_calendar_window_span');
  });

  it('GET returns 403 without HEALTH_VIEW access', async () => {
    const app = createTestApp(async () => ({ rows: [] }));
    const res = await request(app)
      .get(`/api/pets/${petId}/care-calendar?starts_on=${startsOn}&ends_on=${endsOn}`)
      .set(authHeader());
    expect(res.statusCode).toBe(403);
  });

  it('GET returns calendar payload for viewable pet', async () => {
    const app = createTestApp(async (sql) => {
      if (sql.includes('FROM pets WHERE id')) {
        return { rows: [{ id: petId, user_id: userId, home_timezone: 'UTC' }] };
      }
      if (sql.includes('FROM pet_access')) {
        return { rows: [{ pet_id: petId, user_id: userId }] };
      }
      if (sql.includes('SELECT timezone FROM users')) {
        return { rows: [{ timezone: 'UTC' }] };
      }
      if (sql.includes('FROM care_items WHERE pet_id')) {
        return {
          rows: [{
            id: 'entry-1',
            pet_id: petId,
            type: 'medication',
            name: 'Daily pill',
            frequency: 'monthly',
            frequency_interval: 1,
            recurrence_anchor: 'from_due_date',
            next_due_date: startsOn,
            status: 'active',
            schedule_times: null,
            care_family: 'medication',
          }],
        };
      }
      if (sql.includes('FROM care_occurrences')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await request(app)
      .get(`/api/pets/${petId}/care-calendar?starts_on=${startsOn}&ends_on=${endsOn}`)
      .set(authHeader());

    expect(res.statusCode).toBe(200);
    expect(res.body.pet_id).toBe(petId);
    expect(res.body.starts_on).toBe(startsOn);
    expect(res.body.ends_on).toBe(endsOn);
    expect(res.body.before_month).toEqual({ items: [] });
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days.length).toBe(28);
    expect(res.body.as_of.timezone).toBe('UTC');
    expect(res.body.as_of.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.days.some((day) => day.date === res.body.as_of.date)).toBe(
      true,
    );
  });

  it('honours X-Care-As-Of in test env', async () => {
    const app = createTestApp(async (sql) => {
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
    });

    const res = await request(app)
      .get(`/api/pets/${petId}/care-calendar?starts_on=${startsOn}&ends_on=${endsOn}`)
      .set(authHeader())
      .set('X-Care-As-Of', '2025-06-15T09:00');

    expect(res.statusCode).toBe(200);
    expect(res.body.as_of.date).toBe('2025-06-15');
  });
});