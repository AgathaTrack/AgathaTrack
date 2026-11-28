'use strict';

/**
 * Pipeline v2 engine mode (`off` | `dry-run` | `on`). Moved from `issue_pipeline_mode.js` in run D (T1);
 * `issue_pipeline_mode.js` was deleted in T3.
 * Callers pass the env value explicitly (for example `ISSUE_PIPELINE_V2` on the v2 tick).
 */
function resolvePipelineMode(raw = 'off') {
  const mode = String(raw || 'off').trim().toLowerCase();
  if (mode === 'on' || mode === 'dry-run') {
    return mode;
  }
  return 'off';
}

module.exports = {
  resolvePipelineMode,
};
