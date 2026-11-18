#!/usr/bin/env node
'use strict';

/**
 * List Cursor Cloud Agent models; resolve Grok 4.7 medium (standard, non-fast) for pipeline config.
 * Run in the automation environment with CURSOR_API_KEY or cursor_api_key. Read-only; no agent launch.
 */

const CURSOR_API_BASE = 'https://api.cursor.com';

async function cursorGet(apiKey, path) {
  const response = await fetch(`${CURSOR_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(`Cursor API GET ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

function findGrok47Medium(items) {
  const grok = (items || []).filter((m) => /grok[- ]?4\.?7/i.test(String(m.id || m.displayName || '')));
  if (grok.length === 0) {
    return { grokCandidates: [], match: null, reason: 'no grok-4.7 row in GET /v1/models' };
  }
  const preferred = [];
  for (const model of grok) {
    for (const variant of model.variants || []) {
      const params = variant.params || [];
      const effort = params.find((p) => p.id === 'reasoning_effort' || /effort/i.test(String(p.id)));
      const speed = params.find((p) => /speed|fast/i.test(String(p.id)));
      const effortVal = effort?.value ? String(effort.value).toLowerCase() : '';
      const speedVal = speed?.value ? String(speed.value).toLowerCase() : '';
      const isMedium = effortVal === 'medium';
      const isStandard = !speedVal || speedVal === 'standard' || speedVal === 'default' || speedVal === 'normal';
      if (isMedium && isStandard) {
        preferred.push({
          modelId: model.id,
          displayName: model.displayName,
          variantDisplayName: variant.displayName,
          isDefault: Boolean(variant.isDefault),
          params,
        });
      }
    }
    if ((model.variants || []).length === 0 && /medium/i.test(String(model.displayName || ''))) {
      preferred.push({
        modelId: model.id,
        displayName: model.displayName,
        variantDisplayName: null,
        isDefault: false,
        params: [],
      });
    }
  }
  preferred.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const match = preferred[0] || null;
  return {
    grokCandidates: grok.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      aliases: m.aliases,
      variantCount: (m.variants || []).length,
    })),
    match,
    reason: match ? 'ok' : 'no medium standard variant; inspect full variants in log',
  };
}

async function main() {
  const apiKey = process.env.CURSOR_API_KEY || process.env.cursor_api_key;
  if (!apiKey?.trim()) {
    console.error('CURSOR_API_KEY or cursor_api_key is required');
    process.exit(1);
  }
  const { items } = await cursorGet(apiKey, '/v1/models');
  const resolved = findGrok47Medium(items);
  const grok = resolved.match;
  const out = {
    event: 'pipeline_cursor_model_probe',
    grok_4_7_medium: grok
      ? {
          /** Value for pipeline-agents.json `model` when launch sends id only */
          configModelId: grok.modelId,
          launchBody:
            grok.params?.length > 0
              ? { id: grok.modelId, params: grok.params }
              : { id: grok.modelId },
          displayName: grok.displayName,
          variantDisplayName: grok.variantDisplayName,
          isDefaultVariant: grok.isDefault,
          note:
            grok.params?.length > 0
              ? 'PR 2 adapter must pass model.params to POST /v1/agents, not id alone'
              : 'id alone is enough for launch-cursor-agent.js',
        }
      : null,
    ...resolved,
    composer_2_5: (items || []).find((m) => m.id === 'composer-2.5' || (m.aliases || []).includes('composer-2.5'))?.id || 'composer-2.5',
  };
  console.log(JSON.stringify(out, null, 2));
  if (!grok) {
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});