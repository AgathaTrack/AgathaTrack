import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { DEMO_IDS } from '../../../db/seeds/demo-constants.js';
import { seedActiveDemoOrgFixtures } from '../../../db/seeds/scenarios/index.js';
import { seedGuardian } from '../../../db/seeds/scenarios/guardian.js';
import { seedHealthCare } from '../../../db/seeds/scenarios/health-care.js';
import { createDbPool } from '../helpers/careHarness.js';

let pool;
let client;
let dbReady = false;

beforeAll(async () => {
  pool = createDbPool();
  try {
    const ready = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'care_items'",
    );
    if (ready.rows.length === 0) return;
  } catch {
    return;
  }
  client = await pool.connect();
  await client.query('BEGIN');
  await seedGuardian(client);
  await seedActiveDemoOrgFixtures(client);
  await seedHealthCare(client);
  dbReady = true;
}, 60000);

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
  await pool?.end();
});

describe('health-care seed prerequisites', () => {
  it('inserts Max flea treatment after Rescue Hearts org pet exists', async () => {
    if (!dbReady) return;
    const pet = await client.query('SELECT id, organization_id FROM pets WHERE id = $1', [
      DEMO_IDS.maxPet,
    ]);
    expect(pet.rowCount).toBe(1);
    expect(pet.rows[0].organization_id).toBe(DEMO_IDS.rescueHeartsOrg);

    const care = await client.query('SELECT id, pet_id FROM care_items WHERE id = $1', [
      DEMO_IDS.maxFleaTreatment,
    ]);
    expect(care.rowCount).toBe(1);
    expect(care.rows[0].pet_id).toBe(DEMO_IDS.maxPet);
  });
});