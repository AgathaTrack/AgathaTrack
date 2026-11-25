/**
 * Deploy 1 (#2405): legacy SQL against health_* views must keep working, including
 * INSERT ... ON CONFLICT on health_occurrences (occurrenceRepository).
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { insertOpenOccurrence } from '../../lib/care/occurrence/occurrenceRepository.js';
import { createDbPool, createOwner, removeOwner } from './helpers/careHarness.js';

let pool;

beforeAll(() => {
  pool = createDbPool();
}, 30000);

afterAll(async () => {
  if (pool) await pool.end();
});

describe('migration 107 compatibility views', () => {
  it('exposes care_items physical tables and health_* views', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('care_items', 'care_occurrences', 'health_entries', 'health_occurrences')
       ORDER BY table_name`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.table_name, r.table_type]));
    expect(byName.care_items).toBe('BASE TABLE');
    expect(byName.care_occurrences).toBe('BASE TABLE');
    expect(byName.health_entries).toBe('VIEW');
    expect(byName.health_occurrences).toBe('VIEW');
  });

  it('supports INSERT ON CONFLICT via health_occurrences view', async () => {
    const owner = await createOwner(pool);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO health_entries (
           id, pet_id, user_id, type, name, frequency, care_importance
         ) VALUES (gen_random_uuid(), $1, $2, 'medication', 'Compat', 'daily', 'routine')
         RETURNING id`,
        [owner.petId, owner.userId],
      );
      const entryId = rows[0].id;
      const first = await insertOpenOccurrence(client, {
        entryId,
        date: '2099-04-01',
        time: '08:00',
        origin: 'computed',
      });
      const second = await insertOpenOccurrence(client, {
        entryId,
        date: '2099-04-01',
        time: '08:00',
        origin: 'computed',
      });
      expect(first).toBeTruthy();
      expect(second).toBeNull();
      await client.query('ROLLBACK');
    } finally {
      client.release();
      await removeOwner(pool, owner);
    }
  });
});