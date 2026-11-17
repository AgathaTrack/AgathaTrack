'use strict';

const AAT_LABELS = {
  progress: 'AAT-progress',
  passed: 'AAT-passed',
  failed: 'AAT-failed',
};

/** @param {'start'|'pass'|'fail'} outcome */
function aatLabelPlan(outcome) {
  const all = [AAT_LABELS.progress, AAT_LABELS.passed, AAT_LABELS.failed];
  let add;
  if (outcome === 'start') add = [AAT_LABELS.progress];
  else if (outcome === 'pass') add = [AAT_LABELS.passed];
  else if (outcome === 'fail') add = [AAT_LABELS.failed];
  else throw new Error(`unknown AAT outcome: ${outcome}`);
  const remove = all.filter((l) => !add.includes(l));
  return { add, remove };
}

module.exports = { AAT_LABELS, aatLabelPlan };