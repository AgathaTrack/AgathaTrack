import request from 'supertest';
import { createApp } from '../../bin/server.js';
import { createMockPool, makePetRow, token, petId } from './helpers.js';

// R-01a (#1653): clients stop sending vetId on create. A replayed create for an
// existing pet must not clear its stored vet link when vetId is omitted.
describe('POST /api/pets vet link on create replay (R-01a)', () => {
  function buildCreateApp(onInsert) {
    return createApp(createMockPool(async (sql, params) => {
      if (sql.includes('INSERT INTO pets')) {
        onInsert(params, sql);
        return { rows: [makePetRow()] };
      }
      if (sql.includes('SELECT * FROM pets WHERE id = $1')) {
        return { rows: [makePetRow()] };
      }
      return null;
    }));
  }

  it('sends vetProvided=false when the create omits vetId, so the conflict path keeps vet_id', async () => {
    let insertParams;
    let insertSql;
    const res = await request(buildCreateApp((params, sql) => { insertParams = params; insertSql = sql; }))
      .post('/api/pets')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: petId, name: 'Fluffy', species: 'cat' });

    expect(res.statusCode).toBeLessThan(300);
    expect(insertSql).toContain('vet_id = CASE WHEN $28 THEN EXCLUDED.vet_id ELSE pets.vet_id END');
    expect(insertParams).toHaveLength(28);
    expect(insertParams[22]).toBeNull();
    expect(insertParams[27]).toBe(false);
  });

  it('sends vetProvided=true when the create carries vetId, so a replay can set the link', async () => {
    let insertParams;
    const res = await request(buildCreateApp((params) => { insertParams = params; }))
      .post('/api/pets')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: petId, name: 'Fluffy', species: 'cat', vetId: 'vet-uuid-9' });

    expect(res.statusCode).toBeLessThan(300);
    expect(insertParams[22]).toBe('vet-uuid-9');
    expect(insertParams[27]).toBe(true);
  });
});
