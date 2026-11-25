/**
 * Helpers for the Node migration runner: keep incremental SQL inside the runner's
 * outer transaction (NNN_*.sql files must not COMMIT early).
 */

/** @typedef {{ line: number, kind: string }} MigrationSqlTransactionViolation */

/**
 * A transaction-control statement at a statement start (semicolon required).
 * Does not match PL/pgSQL `BEGIN` inside `DO $$ … $$` (no trailing semicolon) or a bare `END;`.
 */
const TX_STATEMENT =
  /^(BEGIN(?:\s+TRANSACTION)?|START\s+TRANSACTION|COMMIT|END\s+TRANSACTION)\s*;/i;

/** Only whitespace or a `--` comment may follow a wrapper for the whole line to be dropped. */
const BLANK_OR_LINE_COMMENT = /^\s*(?:--.*)?$/;

/** Characters that continue an identifier; a `$` after one is part of the name, not a quote. */
const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

/** `$$` or `$tag$` (tag is an identifier that does not start with a digit). */
const DOLLAR_QUOTE_OPEN = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;

/**
 * Lexer state carried across lines. `mode` is one of
 * `normal`, `single` (string literal), `double` (quoted identifier), `dollar` or `block`
 * (`/* … *\/`, nested as PostgreSQL nests them); line comments end with their line so they
 * need no carried state. `blockResumesStart` records whether a block that opened at a statement
 * start (`/* … *\/ COMMIT;`) must hand the statement start back when it closes.
 *
 * @typedef {{ mode: 'normal'|'single'|'double'|'dollar'|'block', dollarTag: string|null, backslashEscapes: boolean, blockDepth: number, blockResumesStart: boolean }} MigrationSqlLexState
 */

/** @returns {MigrationSqlLexState} */
function initialLexState() {
  return {
    mode: 'normal',
    dollarTag: null,
    backslashEscapes: false,
    blockDepth: 0,
    blockResumesStart: false,
  };
}

/**
 * Whether the `'` at `index` opens an `E'…'` string, where backslash escapes the next character.
 * @param {string} line
 * @param {number} index
 */
function opensEscapeString(line, index) {
  if (index === 0 || !/[eE]/.test(line[index - 1])) return false;
  return index === 1 || !IDENTIFIER_CHAR.test(line[index - 2]);
}

/**
 * Scan one line with the six-state tokenizer (normal, single-quoted, double-quoted identifier,
 * line comment, dollar quote, block comment). A statement starts at the beginning of a line that opens in the
 * normal state and after every `;` in the normal state; a statement that is a
 * `BEGIN`/`COMMIT`/… wrapper is a violation.
 *
 * `omitLine` is true only when the whole line is such a wrapper (optionally followed by a `--`
 * comment): a wrapper that shares its line with other SQL (`SELECT 1; COMMIT;`) is reported but
 * never rewritten, so strip never changes the SQL that would run.
 *
 * @param {string} line
 * @param {MigrationSqlLexState} state
 * @returns {{ state: MigrationSqlLexState, omitLine: boolean, violations: MigrationSqlTransactionViolation[] }}
 */
function classifyMigrationSqlLine(line, state) {
  let { mode, dollarTag, backslashEscapes, blockDepth, blockResumesStart } = state;
  let omitLine = false;
  const violations = [];
  let atStatementStart = mode === 'normal';
  let i = 0;

  while (i < line.length) {
    if (mode === 'dollar') {
      const closeIdx = line.indexOf(dollarTag, i);
      if (closeIdx === -1) break;
      i = closeIdx + dollarTag.length;
      mode = 'normal';
      dollarTag = null;
      continue;
    }

    if (mode === 'block') {
      // An unterminated block runs to end of input, as in PostgreSQL, which rejects the file.
      if (line[i] === '/' && line[i + 1] === '*') {
        blockDepth += 1;
        i += 2;
      } else if (line[i] === '*' && line[i + 1] === '/') {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) {
          mode = 'normal';
          atStatementStart = blockResumesStart;
        }
      } else {
        i += 1;
      }
      continue;
    }

    if (mode === 'single') {
      const ch = line[i];
      if (backslashEscapes && ch === '\\') {
        i += 2;
      } else if (ch === "'") {
        if (line[i + 1] === "'") {
          i += 2;
        } else {
          mode = 'normal';
          i += 1;
        }
      } else {
        i += 1;
      }
      continue;
    }

    if (mode === 'double') {
      if (line[i] === '"') {
        if (line[i + 1] === '"') {
          i += 2;
        } else {
          mode = 'normal';
          i += 1;
        }
      } else {
        i += 1;
      }
      continue;
    }

    // normal state
    if (atStatementStart) {
      while (i < line.length && /\s/.test(line[i])) i += 1;
      if (line.startsWith('/*', i)) {
        // A leading block comment does not start the statement: keep the statement start pending.
        mode = 'block';
        blockDepth = 1;
        blockResumesStart = true;
        i += 2;
        continue;
      }
      atStatementStart = false;
      const match = TX_STATEMENT.exec(line.slice(i));
      if (match) {
        violations.push({ line: 0, kind: match[1].split(/\s/)[0].toUpperCase() });
        const end = i + match[0].length;
        if (line.slice(0, i).trim() === '' && BLANK_OR_LINE_COMMENT.test(line.slice(end))) {
          omitLine = true;
        }
        i = end;
        atStatementStart = true;
        continue;
      }
      if (i >= line.length) break;
    }

    const ch = line[i];
    if (ch === '-' && line[i + 1] === '-') break;
    if (ch === '/' && line[i + 1] === '*') {
      mode = 'block';
      blockDepth = 1;
      blockResumesStart = false;
      i += 2;
      continue;
    }
    if (ch === "'") {
      backslashEscapes = opensEscapeString(line, i);
      mode = 'single';
    } else if (ch === '"') {
      mode = 'double';
    } else if (ch === '$' && (i === 0 || !IDENTIFIER_CHAR.test(line[i - 1]))) {
      DOLLAR_QUOTE_OPEN.lastIndex = i;
      const open = DOLLAR_QUOTE_OPEN.exec(line);
      if (open) {
        mode = 'dollar';
        dollarTag = open[0];
        i += open[0].length;
        continue;
      }
    } else if (ch === ';') {
      atStatementStart = true;
    }
    i += 1;
  }

  return {
    state: { mode, dollarTag, backslashEscapes, blockDepth, blockResumesStart },
    omitLine,
    violations,
  };
}

/**
 * @param {string} sql
 * @returns {MigrationSqlTransactionViolation[]}
 */
export function findTopLevelSqlTransactionViolations(sql) {
  const violations = [];
  let state = initialLexState();

  const lines = String(sql || '').split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const result = classifyMigrationSqlLine(lines[lineIndex], state);
    state = result.state;
    for (const violation of result.violations) {
      violations.push({ ...violation, line: lineIndex + 1 });
    }
  }

  return violations;
}

/**
 * Remove legacy top-level `BEGIN;` / `COMMIT;` wrappers before apply (grandfathered
 * migrations 001–105). Semicolon required; never strips PL/pgSQL `BEGIN` inside `$$`, and drops a
 * wrapper only when it is the whole line (see {@link classifyMigrationSqlLine}).
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripTopLevelSqlTransactionWrappers(sql) {
  const out = [];
  let state = initialLexState();

  for (const line of String(sql || '').split('\n')) {
    const result = classifyMigrationSqlLine(line, state);
    state = result.state;
    if (!result.omitLine) out.push(line);
  }

  return out.join('\n').trim();
}

/**
 * @param {import('pg').PoolClient} client
 * @returns {Promise<string>}
 */
export async function captureRunnerTransactionId(client) {
  const { rows } = await client.query('SELECT txid_current()::text AS tx');
  return rows[0].tx;
}

/**
 * @param {import('pg').PoolClient} client
 * @param {string} txBefore from {@link captureRunnerTransactionId}
 * @throws {Error} when the client left or restarted the runner transaction
 */
export async function assertRunnerTransactionUnchanged(client, txBefore) {
  const { rows } = await client.query('SELECT txid_current()::text AS tx');
  const txAfter = rows[0]?.tx;
  if (txAfter !== txBefore) {
    throw new Error(
      'migration left the runner transaction (remove BEGIN/COMMIT from NNN_*.sql or fix the hook)',
    );
  }
}
