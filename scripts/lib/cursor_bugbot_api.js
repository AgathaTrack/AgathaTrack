'use strict';

const CURSOR_API_BASE = 'https://api.cursor.com';

/**
 * Queue a Bugbot review (async on Cursor side).
 * @param {{ prUrl: string, apiKey: string, dryRun?: boolean, fetchImpl?: typeof fetch }} opts
 */
async function queueBugbotReview({ prUrl, apiKey, dryRun = false, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new Error('CURSOR_API_KEY is required to queue Bugbot review');
  }
  const body = { prUrl };
  if (dryRun) body.dryRun = true;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  let response = await fetchImpl(`${CURSOR_API_BASE}/bugbot/review`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    const basic = Buffer.from(`${apiKey}:`, 'utf8').toString('base64');
    response = await fetchImpl(`${CURSOR_API_BASE}/bugbot/review`, {
      method: 'POST',
      headers: { ...headers, Authorization: `Basic ${basic}` },
      body: JSON.stringify(body),
    });
  }

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`Bugbot review queue failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

module.exports = {
  CURSOR_API_BASE,
  queueBugbotReview,
};