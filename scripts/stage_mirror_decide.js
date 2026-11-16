'use strict';

function normalizeStage(name) {
  if (name == null || name === '') {
    return '';
  }
  return String(name).trim().toLowerCase();
}

function stagesEqual(a, b) {
  return normalizeStage(a) === normalizeStage(b);
}

function fieldMatchesColumn(fieldValue, validColumns) {
  if (!fieldValue) {
    return false;
  }
  const norm = normalizeStage(fieldValue);
  return (validColumns || []).some((column) => normalizeStage(column) === norm);
}

/**
 * Stateless reconcile for one board item (P=project Status, F=org Stage field, S=Synced stage).
 *
 * @returns {{ action: 'none'|'sync_s'|'field_from_board'|'board_from_field', newP?: string, newF?: string, newS?: string, reason: string }}
 */
function decideStageMirror(P, F, S, validColumns) {
  const p = P ?? '';
  const f = F ?? '';
  const s = S ?? '';
  const sEmpty = normalizeStage(s) === '';
  const fInvalid = f !== '' && !fieldMatchesColumn(f, validColumns);

  if (stagesEqual(p, f) && p !== '') {
    if (!stagesEqual(p, s)) {
      return { action: 'sync_s', newS: p, reason: 'in_sync_refresh_s' };
    }
    return { action: 'none', reason: 'in_sync' };
  }

  if (!stagesEqual(p, s) && stagesEqual(f, s) && !sEmpty) {
    return { action: 'field_from_board', newF: p, newS: p, reason: 'card_moved' };
  }

  if (!stagesEqual(f, s) && stagesEqual(p, s) && !sEmpty && !fInvalid) {
    return { action: 'board_from_field', newP: f, newS: f, reason: 'field_changed' };
  }

  const conflictReason = fInvalid ? 'invalid_field_board_wins' : 'conflict_board_wins';
  return {
    action: 'field_from_board',
    newF: p,
    newS: p,
    reason: sEmpty ? 'first_run_board_wins' : conflictReason,
  };
}

module.exports = {
  normalizeStage,
  stagesEqual,
  fieldMatchesColumn,
  decideStageMirror,
};