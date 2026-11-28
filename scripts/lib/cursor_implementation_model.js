'use strict';

/**
 * Canonical Cursor model id for implementation, doorbells, execute-plan workers, and babysit.
 * SSOT for the slug: docs/agent-efficiency/pr-review-cost-efficiency.md §Cloud Agent model policy.
 */
const IMPLEMENTATION_MODEL = 'composer-2.5';

const FAST_MODEL_PATTERN = /(^composer-2\.5-fast$|-fast$)/i;

/**
 * Resolve the model id to send on POST /v1/agents. Never returns empty.
 * @param {string|undefined|null} preferred Agent config or explicit caller override.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveLaunchModel(preferred, env = process.env) {
  const fromEnv = env.CURSOR_AGENT_MODEL;
  const raw =
    typeof preferred === 'string' && preferred.trim().length > 0
      ? preferred.trim()
      : typeof fromEnv === 'string' && fromEnv.trim().length > 0
        ? fromEnv.trim()
        : IMPLEMENTATION_MODEL;
  return raw;
}

/**
 * Refuse explicit fast-variant ids on automated implementation launches (env or config typo).
 * Does not prove the platform runs the non-fast SKU — use scripts/cursor_launch_model_audit.js after launch.
 * @param {string} modelId
 */
function assertImplementationModelNotFast(modelId) {
  if (FAST_MODEL_PATTERN.test(String(modelId))) {
    throw new Error(
      `refusing Cursor launch with fast model id "${modelId}"; use ${IMPLEMENTATION_MODEL} per pr-review-cost-efficiency.md`,
    );
  }
}

/**
 * @param {string|undefined|null} preferred
 * @param {{ refuseFast?: boolean }} [opts]
 * @returns {string}
 */
function resolveImplementationLaunchModel(preferred, opts = {}) {
  const id = resolveLaunchModel(preferred);
  if (opts.refuseFast !== false) {
    assertImplementationModelNotFast(id);
  }
  return id;
}

function logLaunchModel(modelId, context = {}) {
  console.log(
    JSON.stringify({
      event: 'cursor_launch_model',
      model: modelId,
      ...context,
    }),
  );
}

module.exports = {
  IMPLEMENTATION_MODEL,
  FAST_MODEL_PATTERN,
  resolveLaunchModel,
  resolveImplementationLaunchModel,
  assertImplementationModelNotFast,
  logLaunchModel,
};