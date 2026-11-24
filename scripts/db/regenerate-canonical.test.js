'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const SCRIPT = path.join(__dirname, 'regenerate-canonical.sh');

function writeExe(file, body) {
  fs.writeFileSync(file, body, { mode: 0o755 });
}

async function run(env) {
  try {
    const { stdout, stderr } = await execFileAsync('bash', [SCRIPT], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    return {
      status: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout || '',
      stderr: err.stderr || String(err.message || err),
    };
  }
}

test('production guard refuses and leaves the schema byte-identical', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-prod-'));
  const schema = path.join(dir, 'canonical.sql');
  const bytes = Buffer.from('SENTINEL-SCHEMA\n');
  fs.writeFileSync(schema, bytes);
  const result = await run({ APP_ENV: 'production', CANONICAL_SQL: schema });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /production/);
  assert.deepEqual(fs.readFileSync(schema), bytes);
});

test('failing normaliser leaves the schema byte-identical and names the normalize stage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-norm-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  writeExe(path.join(bin, 'pg_isready'), '#!/bin/sh\nexit 0\n');
  writeExe(path.join(bin, 'psql'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
  writeExe(path.join(bin, 'pg_dump'), '#!/bin/sh\necho "CREATE TABLE ok ();"\n');
  writeExe(path.join(bin, 'bootstrap'), '#!/bin/sh\nexit 0\n');
  const normaliser = path.join(dir, 'fail-normalize.js');
  fs.writeFileSync(normaliser, 'process.exit(1);\n');
  const schema = path.join(dir, 'canonical.sql');
  const bytes = Buffer.from('COMMITTED-SCHEMA-BYTES\n');
  fs.writeFileSync(schema, bytes);
  const result = await run({
    APP_ENV: 'development',
    CANONICAL_SQL: schema,
    REGENERATE_PG_ISREADY: path.join(bin, 'pg_isready'),
    REGENERATE_PSQL: path.join(bin, 'psql'),
    REGENERATE_PG_DUMP: path.join(bin, 'pg_dump'),
    REGENERATE_BOOTSTRAP: path.join(bin, 'bootstrap'),
    REGENERATE_NORMALIZE: normaliser,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /stage normalize failed/);
  assert.deepEqual(fs.readFileSync(schema), bytes);
});

test('failing dump leaves the schema byte-identical and names the dump stage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-dump-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  writeExe(path.join(bin, 'pg_isready'), '#!/bin/sh\nexit 0\n');
  writeExe(path.join(bin, 'psql'), '#!/bin/sh\ncat >/dev/null\nexit 0\n');
  writeExe(path.join(bin, 'pg_dump'), '#!/bin/sh\necho boom >&2\nexit 1\n');
  writeExe(path.join(bin, 'bootstrap'), '#!/bin/sh\nexit 0\n');
  const schema = path.join(dir, 'canonical.sql');
  const bytes = Buffer.from('COMMITTED-SCHEMA-BYTES\n');
  fs.writeFileSync(schema, bytes);
  const result = await run({
    APP_ENV: 'development',
    CANONICAL_SQL: schema,
    REGENERATE_PG_ISREADY: path.join(bin, 'pg_isready'),
    REGENERATE_PSQL: path.join(bin, 'psql'),
    REGENERATE_PG_DUMP: path.join(bin, 'pg_dump'),
    REGENERATE_BOOTSTRAP: path.join(bin, 'bootstrap'),
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /stage dump failed/);
  assert.deepEqual(fs.readFileSync(schema), bytes);
  const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('.canonical'));
  assert.deepEqual(leftovers, []);
});
