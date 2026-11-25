import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export const DEFAULT_CARE_TABLES = {
  items: 'care_items',
  occurrences: 'care_occurrences',
};

export const LEGACY_CARE_TABLES = {
  items: 'health_entries',
  occurrences: 'health_occurrences',
};

/** @returns {{ items: string, occurrences: string }} */
export function careTables() {
  return storage.getStore() ?? DEFAULT_CARE_TABLES;
}

/**
 * Run code against legacy physical table names (pre-107 migrations / hooks).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function runWithLegacyCareTables(fn) {
  return storage.run(LEGACY_CARE_TABLES, fn);
}