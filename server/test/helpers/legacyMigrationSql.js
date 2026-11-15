/**
 * FROZEN copy of the pre-#2116 line classifier from `scripts/lib/migration_sql.js`
 * (the regex-based `$tag$` scanner). Do not edit: `migrationSql.corpus.test.js` uses it
 * as the byte-identical reference for the strip output on every `db/migrations/**.sql`.
 */

/**
 * Lines that end the runner-owned transaction (semicolon required).
 * Does not match PL/pgSQL `BEGIN` inside `DO $$ … $$` (no trailing semicolon on that line).
 */
const TOP_LEVEL_TX_LINE =
  /^(?:BEGIN\s*;|BEGIN\s+TRANSACTION\s*;|START\s+TRANSACTION\s*;|COMMIT\s*;|END\s+TRANSACTION\s*;)\s*(?:--.*)?$/i;

/**
 * @param {string} line
 * @param {boolean} inDollarQuote
 * @param {string|null} dollarTag
 * @returns {{ inDollarQuote: boolean, dollarTag: string|null, omitLine: boolean, violation: MigrationSqlTransactionViolation|null }}
 */
function legacyClassifyMigrationSqlLine(line, inDollarQuote, dollarTag) {
  let omitLine = false;
  let violation = null;
  let rest = line;

  while (rest.length > 0) {
    if (inDollarQuote) {
      const closeIdx = rest.indexOf(dollarTag);
      if (closeIdx === -1) {
        break;
      }
      rest = rest.slice(closeIdx + dollarTag.length);
      inDollarQuote = false;
      dollarTag = null;
      continue;
    }

    const openMatch = rest.match(/\$([A-Za-z0-9_]*)\$/);
    if (openMatch && openMatch.index != null) {
      rest = rest.slice(openMatch.index + openMatch[0].length);
      dollarTag = openMatch[0];
      inDollarQuote = true;
      continue;
    }

    const trimmed = rest.trimStart();
    if (TOP_LEVEL_TX_LINE.test(trimmed)) {
      omitLine = true;
      const kindMatch = trimmed.match(
        /^(BEGIN|COMMIT|START|END)(?:\s+TRANSACTION)?\s*;/i,
      );
      violation = {
        line: 0,
        kind: kindMatch ? kindMatch[1].toUpperCase() : trimmed.split(/\s/)[0].toUpperCase(),
      };
    }
    break;
  }

  return { inDollarQuote, dollarTag, omitLine, violation };
}

/**
 * @param {string} sql
 * @returns {MigrationSqlTransactionViolation[]}
 */
export function legacyFindTopLevelSqlTransactionViolations(sql) {
  const violations = [];
  let inDollarQuote = false;
  let dollarTag = null;

  const lines = String(sql || '').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const result = legacyClassifyMigrationSqlLine(lines[lineIndex], inDollarQuote, dollarTag);
    inDollarQuote = result.inDollarQuote;
    dollarTag = result.dollarTag;
    if (result.violation) {
      violations.push({ ...result.violation, line: lineIndex + 1 });
    }
  }

  return violations;
}

/**
 * Remove legacy top-level `BEGIN;` / `COMMIT;` wrappers before apply (grandfathered
 * migrations 001–105). Semicolon required; never strips PL/pgSQL `BEGIN` inside `$$`.
 *
 * @param {string} sql
 * @returns {string}
 */
export function legacyStripTopLevelSqlTransactionWrappers(sql) {
  const out = [];
  let inDollarQuote = false;
  let dollarTag = null;

  for (const line of String(sql || '').split('\n')) {
    const result = legacyClassifyMigrationSqlLine(line, inDollarQuote, dollarTag);
    inDollarQuote = result.inDollarQuote;
    dollarTag = result.dollarTag;
    if (!result.omitLine) out.push(line);
  }

  return out.join('\n').trim();
}
