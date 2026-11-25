/**
 * Migration 105 — care item Closed status (CARE-STATUS-R-009, R-013 items).
 * Adds `care_closed_reason`, migrates `completed` → `closed` with ended / stopped_by_user.
 *
 * @param {import('pg').PoolClient} client
 */

/** @param {import('pg').PoolClient} client */
async function resolveCareItemTable(client) {
  const { rows } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('care_items', 'health_entries')
       AND table_type = 'BASE TABLE'
     ORDER BY CASE WHEN table_name = 'care_items' THEN 0 ELSE 1 END
     LIMIT 1`,
  );
  if (rows.length === 0) {
    throw new Error('migrateCareItemClosed: no physical care item table');
  }
  return rows[0].table_name;
}

export async function migrateCareItemClosed(client) {
  const table = await resolveCareItemTable(client);
  const hasColumn = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'care_closed_reason'`,
    [table],
  );
  if (hasColumn.rows.length > 0) {
    return;
  }

  await client.query(`
    ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS care_closed_reason VARCHAR(50);
  `);

  await client.query(`
    ALTER TABLE ${table}
      DROP CONSTRAINT IF EXISTS health_entries_status_check;
  `);

  await client.query(`
    ALTER TABLE ${table}
      DROP CONSTRAINT IF EXISTS health_entries_care_closed_reason_check;
  `);

  const hasAudit = await client.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name = 'audit_events'`,
  );

  if (hasAudit.rows.length > 0) {
    await client.query(`
      UPDATE ${table} he
      SET status = 'closed',
          care_closed_reason = 'stopped_by_user',
          updated_at = NOW()
      WHERE he.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM audit_events ae
          WHERE ae.action = 'health_entry.closed'
            AND ae.resource_id = he.id::text
        );
    `);
  }

  await client.query(`
    UPDATE ${table}
    SET status = 'closed',
        care_closed_reason = 'ended',
        updated_at = NOW()
    WHERE status = 'completed';
  `);

  await client.query(`
    ALTER TABLE ${table}
      ADD CONSTRAINT health_entries_status_check CHECK (
        status IN ('active', 'paused', 'closed')
      );
  `);

  await client.query(`
    ALTER TABLE ${table}
      ADD CONSTRAINT health_entries_care_closed_reason_check CHECK (
        care_closed_reason IS NULL
        OR care_closed_reason IN ('ended', 'stopped_by_user')
      );
  `);

  await client.query(`
    ALTER TABLE ${table}
      DROP CONSTRAINT IF EXISTS health_entries_closed_reason_required;
  `);

  await client.query(`
    ALTER TABLE ${table}
      ADD CONSTRAINT health_entries_closed_reason_required CHECK (
        status <> 'closed' OR care_closed_reason IS NOT NULL
      );
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION health_entries_normalize_closed_status()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.status = 'completed' THEN
        NEW.status := 'closed';
        NEW.care_closed_reason := COALESCE(NEW.care_closed_reason, 'ended');
      END IF;
      RETURN NEW;
    END;
    $$;
  `);

  await client.query(`
    DROP TRIGGER IF EXISTS health_entries_normalize_closed_status ON ${table};
  `);

  await client.query(`
    CREATE TRIGGER health_entries_normalize_closed_status
      BEFORE INSERT OR UPDATE OF status, care_closed_reason ON ${table}
      FOR EACH ROW
      EXECUTE PROCEDURE health_entries_normalize_closed_status();
  `);
}