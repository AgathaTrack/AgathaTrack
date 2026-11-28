'use strict';

const MODEL_KEY = /(^model$|modelId$|model_id$|modelName$|model_name$)/i;

/**
 * Collect model-related fields from a JSON tree (shallow object walk).
 * @param {unknown} value
 * @param {string} [prefix]
 * @param {Record<string, unknown>} [out]
 */
function collectModelHints(value, prefix = '', out = {}) {
  if (value == null || typeof value !== 'object') {
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectModelHints(item, `${prefix}[${index}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (MODEL_KEY.test(key) && (typeof child === 'string' || (child && typeof child === 'object' && child.id))) {
      out[path] = typeof child === 'object' ? child.id ?? child : child;
    }
    if (child && typeof child === 'object') {
      collectModelHints(child, path, out);
    }
  }
  return out;
}

/**
 * @param {string} base
 * @param {string} path
 * @param {string} apiKey
 */
async function cursorGet(base, path, apiKey) {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { ok: response.ok, status: response.status, payload, path };
}

/**
 * @param {{ apiKey: string, agentId: string, runId: string, base?: string, fetchFn?: typeof fetch }} params
 */
async function auditCursorLaunchModel({ apiKey, agentId, runId, base, fetchFn = fetch }) {
  const apiBase = base || require('../../.github/scripts/execute-plan-launch').CURSOR_API_BASE;
  const get = (path) =>
    fetchFn(`${apiBase}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    }).then(async (response) => {
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      return { ok: response.ok, status: response.status, payload, path };
    });

  const agentRes = await get(`/v1/agents/${agentId}`);
  const runRes = await get(`/v1/agents/${agentId}/runs/${runId}`);

  const agentHints = agentRes.ok ? collectModelHints(agentRes.payload) : {};
  const runHints = runRes.ok ? collectModelHints(runRes.payload) : {};

  const merged = { ...agentHints, ...runHints };
  const servedModelAvailable = Object.keys(merged).length > 0;

  return {
    event: 'cursor_launch_model_audit',
    agent: agentId,
    run: runId,
    requests: {
      agent: { ok: agentRes.ok, status: agentRes.status, topLevelKeys: Object.keys(agentRes.payload || {}).sort() },
      run: { ok: runRes.ok, status: runRes.status, topLevelKeys: Object.keys(runRes.payload || {}).sort() },
    },
    runStatus: runRes.ok ? runRes.payload.status ?? null : null,
    modelHints: merged,
    servedModelAvailable,
    note: servedModelAvailable
      ? null
      : 'No model fields on GET /v1/agents/{id} or GET /v1/agents/{id}/runs/{runId}; compare Actions log cursor_launch_model with the dashboard or ask Cursor support for the served-model field.',
  };
}

module.exports = { collectModelHints, auditCursorLaunchModel, cursorGet };