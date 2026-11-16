'use strict';

/**
 * Shared ISSUE_PIPELINE mode for every entry point (dispatcher, intake, todo shortcut).
 */
function resolvePipelineMode(raw = process.env.ISSUE_PIPELINE) {
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