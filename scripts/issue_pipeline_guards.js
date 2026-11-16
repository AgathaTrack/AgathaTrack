'use strict';

/**
 * Dispatcher fail-closed guards (#2363 review follow-up). Pure; kept apart from the dispatcher
 * for the file-size budget.
 */

const OWNER_LOGIN = 'KanopeeKa';

/**
 * Fail closed on state we cannot trust (#2363 review). A dedicated state comment that failed the
 * trust check stops every lane but intake (which rewrites state). A Ready issue with no state at
 * all is not reopened from default state; the owner looks at it.
 */
function untrustedStateSkipReason(status, source) {
  if (source === 'rejected' && status !== 'To do') {
    return 'untrusted-pipeline-state';
  }
  if (source === 'none' && status === 'Ready') {
    return 'no-pipeline-state';
  }
  return null;
}

/**
 * Owner product edit resets the reopen round (#2363 §3.3): the latest body edit is by the owner
 * and is newer than the last state write. Unknown editor or no edit → no reset.
 */
function isOwnerBodyEdit(edit, stateUpdatedAt) {
  if (!edit || edit.editor !== OWNER_LOGIN || !edit.editedAt) {
    return false;
  }
  if (!stateUpdatedAt) {
    return false;
  }
  return Date.parse(edit.editedAt) > Date.parse(stateUpdatedAt);
}

module.exports = {
  untrustedStateSkipReason,
  isOwnerBodyEdit,
};
