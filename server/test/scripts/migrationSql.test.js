import {
  assertRunnerTransactionUnchanged,
  captureRunnerTransactionId,
  findTopLevelSqlTransactionViolations,
  stripTopLevelSqlTransactionWrappers,
} from '../../scripts/lib/migration_sql.js';

describe('stripTopLevelSqlTransactionWrappers', () => {
  it('removes semicolon BEGIN/COMMIT outside dollar quotes', () => {
    const raw = `-- header\n\nBEGIN;\nALTER TABLE t ADD COLUMN x int;\nCOMMIT;\n`;
    expect(stripTopLevelSqlTransactionWrappers(raw)).toBe(
      '-- header\n\nALTER TABLE t ADD COLUMN x int;',
    );
  });

  it('preserves PL/pgSQL BEGIN inside DO $$', () => {
    const raw = 'DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\n';
    expect(stripTopLevelSqlTransactionWrappers(raw)).toBe(raw.trim());
  });
});

describe('findTopLevelSqlTransactionViolations', () => {
  it('flags semicolon BEGIN/COMMIT outside dollar quotes', () => {
    const raw = `-- header\n\nBEGIN;\nALTER TABLE t ADD COLUMN x int;\nCOMMIT;\n`;
    const v = findTopLevelSqlTransactionViolations(raw);
    expect(v.map((x) => x.kind)).toEqual(['BEGIN', 'COMMIT']);
  });

  it('allows PL/pgSQL BEGIN inside DO $$', () => {
    const raw = 'DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\n';
    expect(findTopLevelSqlTransactionViolations(raw)).toEqual([]);
  });
});

describe('findTopLevelSqlTransactionViolations: string, comment and identifier false starts', () => {
  // `$` inside a string, comment or identifier must not open a dollar quote, otherwise the COMMIT
  // on the next line is swallowed by a phantom quote and the violation is missed.
  const falseStarts = [
    ['`$$` in a single-quoted string', "SELECT '$$';\nCOMMIT;\n", [{ line: 2, kind: 'COMMIT' }]],
    ['`$$` in a line comment', '-- uses $$\nCOMMIT;\n', [{ line: 2, kind: 'COMMIT' }]],
    [
      'E-string with an escaped quote',
      "SELECT E'it\\'s $$';\nCOMMIT;\n",
      [{ line: 2, kind: 'COMMIT' }],
    ],
    ['same-line `;` split', 'SELECT 1; COMMIT;\n', [{ line: 1, kind: 'COMMIT' }]],
    ['`$x$` in a double-quoted identifier', 'SELECT "col$x$";\nCOMMIT;\n', [{ line: 2, kind: 'COMMIT' }]],
    ['`$` inside an unquoted identifier', 'SELECT foo$bar$baz;\nCOMMIT;\n', [{ line: 2, kind: 'COMMIT' }]],
  ];

  it.each(falseStarts)('%s', (_name, sql, expected) => {
    expect(findTopLevelSqlTransactionViolations(sql)).toEqual(expected);
  });

  it('keeps a doubled single quote inside the string', () => {
    expect(findTopLevelSqlTransactionViolations("SELECT 'it''s $$';\nCOMMIT;\n")).toEqual([
      { line: 2, kind: 'COMMIT' },
    ]);
  });

  it('keeps a doubled double quote inside the identifier', () => {
    expect(findTopLevelSqlTransactionViolations('SELECT "a""$$";\nCOMMIT;\n')).toEqual([
      { line: 2, kind: 'COMMIT' },
    ]);
  });

  it('does not flag a wrapper keyword inside a multi-line string or identifier', () => {
    expect(findTopLevelSqlTransactionViolations("SELECT 'a\nCOMMIT;\nb';\n")).toEqual([]);
    expect(findTopLevelSqlTransactionViolations('SELECT "a\nCOMMIT;\nb";\n')).toEqual([]);
  });

  it('ignores a wrapper keyword that follows a line comment', () => {
    expect(findTopLevelSqlTransactionViolations('SELECT 1; -- COMMIT;\n')).toEqual([]);
  });

  it('reports every wrapper on a line', () => {
    expect(findTopLevelSqlTransactionViolations('COMMIT; BEGIN;\n')).toEqual([
      { line: 1, kind: 'COMMIT' },
      { line: 1, kind: 'BEGIN' },
    ]);
  });

  it('reports START TRANSACTION and END TRANSACTION', () => {
    expect(
      findTopLevelSqlTransactionViolations('START TRANSACTION;\nSELECT 1;\nEND TRANSACTION;\n').map(
        (v) => v.kind,
      ),
    ).toEqual(['START', 'END']);
  });
});

describe('findTopLevelSqlTransactionViolations: block comments', () => {
  // Quotes and `$` inside `/* … */` are comment text. Before the block-comment state, an apostrophe
  // opened a string that hid the following COMMIT from lint (regression found in AAT for #2116).
  const blockCases = [
    ["an apostrophe in a block comment", "/* don't */\nCOMMIT;\n", [{ line: 2, kind: 'COMMIT' }]],
    ["`$$` in a block comment", "/* $$ */\nCOMMIT;\n", [{ line: 2, kind: 'COMMIT' }]],
    ["a double quote in a block comment", '/* "x */\nCOMMIT;\n', [{ line: 2, kind: 'COMMIT' }]],
    ["a multi-line block comment with an apostrophe", "/* a\n  don't\n*/\nCOMMIT;\n", [{ line: 4, kind: 'COMMIT' }]],
    ["a nested block comment", "/* a /* b */ 'c */\nCOMMIT;\n", [{ line: 2, kind: 'COMMIT' }]],
    ["`/*` inside a single-quoted string", "SELECT '/*';\nCOMMIT;\n", [{ line: 2, kind: 'COMMIT' }]],
    ["`/*` after a line comment", '-- /*\nCOMMIT;\n', [{ line: 2, kind: 'COMMIT' }]],
    ["a block comment mid statement", 'SELECT 1 /* c */;\nCOMMIT;\n', [{ line: 2, kind: 'COMMIT' }]],
    ["a wrapper that follows a block comment on its line", '/* x */ COMMIT;\n', [{ line: 1, kind: 'COMMIT' }]],
  ];

  it.each(blockCases)('%s', (_name, sql, expected) => {
    expect(findTopLevelSqlTransactionViolations(sql)).toEqual(expected);
  });

  it('does not close a nested block comment at the first `*/`', () => {
    expect(
      findTopLevelSqlTransactionViolations('/* outer /* inner */ still open\nCOMMIT;\n*/\nSELECT 1;\n'),
    ).toEqual([]);
  });

  it('strips a whole-line wrapper that follows a block comment line', () => {
    expect(
      stripTopLevelSqlTransactionWrappers("/* don't */\nCREATE TABLE t (id int);\nCOMMIT;\n"),
    ).toBe("/* don't */\nCREATE TABLE t (id int);");
  });

  it('reports but never strips a wrapper that shares a line with a block comment', () => {
    expect(stripTopLevelSqlTransactionWrappers('/* x */ COMMIT;\n')).toBe('/* x */ COMMIT;');
  });

  it('treats an unterminated block comment as running to end of input', () => {
    // PostgreSQL rejects the file at apply time, so the lint staying silent inside it is safe.
    expect(findTopLevelSqlTransactionViolations('/* open\nCOMMIT;\n')).toEqual([]);
    expect(stripTopLevelSqlTransactionWrappers('/* open\nCOMMIT;\n')).toBe('/* open\nCOMMIT;');
  });
});

describe('findTopLevelSqlTransactionViolations: dollar quotes', () => {
  it('allows BEGIN/COMMIT inside a DO block', () => {
    const sql = 'DO $$\nBEGIN\n  PERFORM 1;\n  COMMIT;\nEND $$;\n';
    expect(findTopLevelSqlTransactionViolations(sql)).toEqual([]);
  });

  it('only closes a tagged quote with the same tag', () => {
    const sql = 'DO $body$\nSELECT $$ not the end;\nCOMMIT;\n$body$;\nCOMMIT;\n';
    expect(findTopLevelSqlTransactionViolations(sql)).toEqual([{ line: 5, kind: 'COMMIT' }]);
  });

  it('opens and closes a quote on the same line, then continues in the normal state', () => {
    expect(findTopLevelSqlTransactionViolations("SELECT $$a;$$; COMMIT;\n")).toEqual([
      { line: 1, kind: 'COMMIT' },
    ]);
  });

  it('treats a quote opened after a string on the same line as a quote', () => {
    const sql = "SELECT 'x', $$\nCOMMIT;\n$$;\n";
    expect(findTopLevelSqlTransactionViolations(sql)).toEqual([]);
  });
});

describe('stripTopLevelSqlTransactionWrappers: false starts', () => {
  it('still strips a wrapper line after a string containing `$$`', () => {
    expect(stripTopLevelSqlTransactionWrappers("SELECT '$$';\nCOMMIT;\n")).toBe("SELECT '$$';");
  });

  it('keeps `COMMIT;` text inside a dollar-quoted body', () => {
    const sql = 'DO $$\nBEGIN\n  COMMIT;\nEND $$;\n';
    expect(stripTopLevelSqlTransactionWrappers(sql)).toBe(sql.trim());
  });

  it('drops a wrapper line that carries a trailing comment', () => {
    expect(stripTopLevelSqlTransactionWrappers('BEGIN; -- wrap\nSELECT 1;\nCOMMIT;\n')).toBe(
      'SELECT 1;',
    );
  });

  it('never rewrites a wrapper that shares its line with other SQL', () => {
    expect(stripTopLevelSqlTransactionWrappers('SELECT 1; COMMIT;\n')).toBe('SELECT 1; COMMIT;');
  });
});

describe('assertRunnerTransactionUnchanged', () => {
  it('passes when txid is unchanged', async () => {
    const client = {
      query: async (sql) => {
        if (sql.includes('txid_current()')) return { rows: [{ tx: '99' }] };
        return { rows: [] };
      },
    };
    const txBefore = await captureRunnerTransactionId(client);
    await assertRunnerTransactionUnchanged(client, txBefore);
  });

  it('throws when txid changes after COMMIT', async () => {
    let pass = 0;
    const client = {
      query: async (sql) => {
        if (sql.includes('txid_current()')) {
          pass += 1;
          return { rows: [{ tx: pass === 1 ? '10' : '11' }] };
        }
        return { rows: [] };
      },
    };
    const txBefore = await captureRunnerTransactionId(client);
    await expect(assertRunnerTransactionUnchanged(client, txBefore)).rejects.toThrow(
      /runner transaction/,
    );
  });
});
