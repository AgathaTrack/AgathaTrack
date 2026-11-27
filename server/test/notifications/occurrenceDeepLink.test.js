import {
  enrichNotificationsWithOccurrenceId,
  occurrenceIdFromNotificationRow,
} from '../../lib/notifications/occurrenceDeepLink.js';

describe('occurrenceDeepLink', () => {
  it('reads occurrence id from suggestion_payload', () => {
    expect(
      occurrenceIdFromNotificationRow({
        suggestion_payload: { health_occurrence_id: 'occ-payload' },
      }),
    ).toBe('occ-payload');
  });

  it('enriches rows with earliest pending occurrence per entry', async () => {
    const entryId = '11111111-1111-4111-8111-111111111111';
    const pool = {
      query: jest.fn(async () => ({
        rows: [{ health_entry_id: entryId, id: 'occ-1' }],
      })),
    };

    const rows = await enrichNotificationsWithOccurrenceId(pool, [
      {
        id: 'n-1',
        health_entry_id: entryId,
        pet_id: 'pet-1',
        suggestion_payload: null,
      },
    ]);

    expect(rows[0].health_occurrence_id).toBe('occ-1');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});