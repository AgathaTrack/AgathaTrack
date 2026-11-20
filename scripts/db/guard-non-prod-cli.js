#!/usr/bin/env node
/**
 * CLI guard for non-prod-only scripts (uat-reset, seed, etc.).
 * Usage: node scripts/db/guard-non-prod.js <operation-name>
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertNonProduction } from './guard-non-prod.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadServerDotEnvUnexported() {
  const envPath = path.resolve(__dirname, '../../server/.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== 'APP_ENV' && key !== 'NODE_ENV') continue;
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadServerDotEnvUnexported();

const operation = process.argv[2] || 'operation';
try {
  assertNonProduction(operation);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
