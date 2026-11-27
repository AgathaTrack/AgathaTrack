import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCanonicalFreshness,
  assertCodeMigrationsParity,
  filterUpMigrationPaths,
  mergePathLists,
  migrationHasNoSchemaChangeMarker,
  parseCodeMigrationKeysFromMigrateSource,
} from './migration-governance-lib.js';

const SAMPLE_MIGRATE = `
const CODE_MIGRATIONS = {
  '016_migrate_family_events_placements.sql': fn1,
  '042_org_member_privacy.sql': fn2,
  '044_org_retire_foster_wire_role.sql': fn3,
};
`;

test('parseCodeMigrationKeysFromMigrateSource extracts sorted keys', () => {
  const keys = parseCodeMigrationKeysFromMigrateSource(SAMPLE_MIGRATE);
  assert.deepEqual(keys, [
    '016_migrate_family_events_placements.sql',
    '042_org_member_privacy.sql',
    '044_org_retire_foster_wire_role.sql',
  ]);
});

test('assertCodeMigrationsParity fails on missing and extra keys', () => {
  assert.throws(
    () =>
      assertCodeMigrationsParity(
        ['016_migrate_family_events_placements.sql', '099_extra.sql'],
        ['016_migrate_family_events_placements.sql', '042_org_member_privacy.sql']
      ),
    (err) => err.message.includes('099_extra') && err.message.includes('042_org_member_privacy')
  );
});

test('filterUpMigrationPaths ignores down migrations', () => {
  const files = [
    'db/migrations/021_x.sql',
    'db/migrations/021_x_down.sql',
    'flutter_app/foo.dart',
  ];
  assert.deepEqual(filterUpMigrationPaths(files), ['db/migrations/021_x.sql']);
});

test('migrationHasNoSchemaChangeMarker requires exact header line', () => {
  const sql = `-- title\n-- canonical: no-schema-change\nCREATE TABLE t (id int);`;
  assert.equal(migrationHasNoSchemaChangeMarker(sql), true);
  assert.equal(migrationHasNoSchemaChangeMarker('CREATE TABLE t (id int);'), false);
  const inString = `-- x\nINSERT INTO t VALUES ('-- canonical: no-schema-change');`;
  assert.equal(migrationHasNoSchemaChangeMarker(inString), false);
});

test('assertCanonicalFreshness requires manifest and canonical when migration changes', () => {
  assert.throws(
    () =>
      assertCanonicalFreshness(['db/migrations/099_new.sql'], () => 'CREATE TABLE x ();'),
    /migration-manifest|canonical/
  );
  assert.doesNotThrow(() =>
    assertCanonicalFreshness(
      ['db/migrations/099_new.sql', 'db/schema/migration-manifest.json', 'db/schema/canonical.sql'],
      () => 'CREATE TABLE x ();'
    )
  );
});

test('assertCanonicalFreshness accepts escape marker without canonical commit', () => {
  const body = `-- canonical: no-schema-change\nINSERT INTO t VALUES (1);`;
  assert.doesNotThrow(() =>
    assertCanonicalFreshness(['db/migrations/099_data.sql'], () => body)
  );
});

test('mergePathLists dedupes paths for freshness union', () => {
  assert.deepEqual(
    mergePathLists(['db/migrations/a.sql', 'b'], ['b', 'c']).sort(),
    ['b', 'c', 'db/migrations/a.sql'].sort()
  );
});