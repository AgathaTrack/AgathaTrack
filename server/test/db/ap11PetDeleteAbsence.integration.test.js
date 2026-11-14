/**
 * AP-11: deleting the only pet on a one-pet absence cancels the absence.
 */
import { randomUUID } from 'crypto';

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { addCalendarDaysIso, todayCalendarIso } from '../../lib/calendarDate.js';
import { deletePet } from '../../lib/petDataLifecycle.js';
import { openStrictHarness } from './helpers/careHarness.js';

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default_secret';

describe('AP-11 pet delete cascades single-pet absence', () => {
  let harness;
  let userId;
  let petId;
  let absenceId;
  const today = todayCalendarIso();
  const startsOn = addCalendarDaysIso(today, 5);
  const endsOn = addCalendarDaysIso(today, 12);

  beforeAll(async () => {
    harness = await openStrictHarness();
    userId = randomUUID();
    petId = randomUUID();
    const email = `ap11-${userId.slice(0, 8)}@example.com`;
    await harness.pool.query(
      `INSERT INTO users (id, email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'hash', 'Away', 'Owner')`,
      [userId, email],
    );
    await harness.pool.query(
      `INSERT INTO pets (id, user_id, name, species, home_timezone)
       VALUES ($1, $2, 'SoloPet', 'dog', 'UTC')`,
      [petId, userId],
    );
    const token = jwt.sign({ id: userId, email }, JWT_SECRET, { expiresIn: '1h' });
    const createRes = await request(harness.app)
      .post('/api/planned-absences')
      .set('Authorization', `Bearer ${token}`)
      .send({ pet_ids: [petId], starts_on: startsOn, ends_on: endsOn });
    expect(createRes.statusCode).toBe(201);
    absenceId = createRes.body.absence.id;
  }, 60000);

  afterAll(async () => {
    if (harness?.pool) {
      await harness.pool.query('DELETE FROM planned_absences WHERE id = $1', [absenceId]).catch(() => {});
      await harness.pool.query('DELETE FROM pets WHERE id = $1', [petId]).catch(() => {});
      await harness.pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
      await harness.pool.end();
    }
  });

  it('cancels the active absence when the only pet is deleted', async () => {
    const before = await harness.pool.query(
      'SELECT status FROM planned_absences WHERE id = $1',
      [absenceId],
    );
    expect(before.rows[0].status).toBe('active');

    await deletePet(harness.pool, petId, { actorUserId: userId });

    const after = await harness.pool.query(
      'SELECT status FROM planned_absences WHERE id = $1',
      [absenceId],
    );
    expect(after.rows[0]?.status).toBe('cancelled');

    const petRow = await harness.pool.query('SELECT id FROM pets WHERE id = $1', [petId]);
    expect(petRow.rows).toHaveLength(0);
  });
});