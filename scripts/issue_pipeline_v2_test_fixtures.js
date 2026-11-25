'use strict';

/** Offline tick tests: no GitHub GraphQL for issue dependencies. */
async function noopBlockedBy() {
  return { open: [], error: null };
}

module.exports = { noopBlockedBy };