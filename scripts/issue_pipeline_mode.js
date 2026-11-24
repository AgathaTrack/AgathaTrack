'use strict';

/**
 * Pipeline engine mode (`off` | `dry-run` | `on`). Callers pass the env value explicitly
 * (for example `ISSUE_PIPELINE_V2` on the v2 tick).
 */
function resolvePipelineMode(raw = 'off') {
  const mode = String(raw || 'off').trim().toLowerCase();
  if (mode === 'on' || mode === 'dry-run') {
    return mode;
  }
  return 'off';
}

function pipelineModeAllowsRun(mode) {
  return resolvePipelineMode(mode) !== 'off';
}

function pipelineModeWritesLive(mode) {
  return resolvePipelineMode(mode) === 'on';
}

module.exports = {
  resolvePipelineMode,
  pipelineModeAllowsRun,
  pipelineModeWritesLive,
};