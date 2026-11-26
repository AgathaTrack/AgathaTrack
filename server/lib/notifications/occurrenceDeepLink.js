const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Optional future emitters may set `suggestion_payload.health_occurrence_id` before a DB column ships. */
export function occurrenceIdFromNotificationRow(row) {
  const payload = row.suggestion_payload;
  if (payload && typeof payload === 'object' && payload.health_occurrence_id) {
    return String(payload.health_occurrence_id);
  }
  return null;
}

function isUuidHealthEntryId(healthEntryId) {
  return healthEntryId && UUID_RE.test(String(healthEntryId));
}

/**
 * Resolve the earliest open occurrence for care-linked inbox rows (batch).
 *
 * @param {import('pg').Pool} pool
 * @param {object[]} rows
 * @returns {Promise<object[]>}
 */
export async function enrichNotificationsWithOccurrenceId(pool, rows) {
  if (!rows?.length) return [];

  const entryIds = [
    ...new Set(
      rows
        .map((row) => row.health_entry_id)
        .filter((id) => isUuidHealthEntryId(id)),
    ),
  ];

  const occurrenceByEntry = new Map();
  if (entryIds.length > 0) {
    const { rows: occurrences } = await pool.query(
      `SELECT DISTINCT ON (health_entry_id) health_entry_id, id
       FROM care_occurrences
       WHERE health_entry_id = ANY($1::uuid[])
         AND status = 'pending'
       ORDER BY health_entry_id, scheduled_date ASC, scheduled_time ASC NULLS LAST`,
      [entryIds],
    );
    for (const occ of occurrences) {
      occurrenceByEntry.set(String(occ.health_entry_id), occ.id);
    }
  }

  return rows.map((row) => {
    const fromPayload = occurrenceIdFromNotificationRow(row);
    const fromSchedule = occurrenceByEntry.get(String(row.health_entry_id || '')) ?? null;
    const healthOccurrenceId = fromPayload ?? fromSchedule;
    return healthOccurrenceId
      ? { ...row, health_occurrence_id: healthOccurrenceId }
      : row;
  });
}