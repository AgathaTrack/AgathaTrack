import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  legacyFindTopLevelSqlTransactionViolations,
  legacyStripTopLevelSqlTransactionWrappers,
} from '../helpers/legacyMigrationSql.js';
import {
  findTopLevelSqlTransactionViolations,
  stripTopLevelSqlTransactionWrappers,
} from '../../scripts/lib/migration_sql.js';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations',
);

/** @param {string} dir */
function listSqlFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return listSqlFiles(full);
      return entry.name.endsWith('.sql') ? [full] : [];
    })
    .sort();
}

const allSqlFiles = listSqlFiles(migrationsDir);
// Same selection as scripts/check_migration_sql_transactions.js.
const incrementalSqlFiles = allSqlFiles.filter(
  (file) =>
    path.dirname(file) === migrationsDir
    && /^\d{3}_.+\.sql$/.test(path.basename(file))
    && !file.includes('_down'),
);

/** Migrations 001-105 keep legacy BEGIN/COMMIT wrappers; the runner strips them on apply. */
const GRANDFATHERED_THROUGH = 105;

const relative = (file) => path.relative(migrationsDir, file);

describe('migration corpus (db/migrations)', () => {
  it('finds the corpus', () => {
    expect(incrementalSqlFiles.length).toBeGreaterThan(50);
    expect(allSqlFiles.length).toBeGreaterThanOrEqual(incrementalSqlFiles.length);
  });

  it('strips to byte-identical output versus the frozen pre-#2116 implementation', () => {
    const differing = allSqlFiles.filter((file) => {
      const sql = fs.readFileSync(file, 'utf8');
      return (
        stripTopLevelSqlTransactionWrappers(sql) !== legacyStripTopLevelSqlTransactionWrappers(sql)
      );
    });
    expect(differing.map(relative)).toEqual([]);
  });

  it('keeps the lint violation set unchanged on every incremental migration', () => {
    const violationsByFile = (find) =>
      Object.fromEntries(
        incrementalSqlFiles.map((file) => [relative(file), find(fs.readFileSync(file, 'utf8'))]),
      );
    const current = violationsByFile(findTopLevelSqlTransactionViolations);
    expect(current).toEqual(violationsByFile(legacyFindTopLevelSqlTransactionViolations));
  });

  it('has no top-level transaction wrapper in any migration after the grandfathered 001-105', () => {
    const flagged = incrementalSqlFiles
      .filter((file) => Number(path.basename(file).slice(0, 3)) > GRANDFATHERED_THROUGH)
      .filter(
        (file) =>
          findTopLevelSqlTransactionViolations(fs.readFileSync(file, 'utf8')).length > 0,
      )
      .map(relative);
    expect(flagged).toEqual([]);
  });
});
