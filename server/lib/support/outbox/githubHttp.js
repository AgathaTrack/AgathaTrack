/* global fetch -- Node 22 built-in */

import { getSupportGithubRepo, getSupportGithubToken } from './config.js';
import { safeOutboxError } from './safeError.js';

export const GITHUB_API_VERSION = '2026-03-10';

export function parseSupportRepoSlug() {
  const slug = getSupportGithubRepo();
  if (!slug) return null;
  const parts = String(slug).trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function githubHeaders() {
  const token = getSupportGithubToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'AgathaTrack-support-outbox',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * @returns {Promise<{ ok: true, status: number, body: any } | { ok: false, status: number, reason: string }>}
 */
export async function githubRequest(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        ...githubHeaders(),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const parsed = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, reason: safeOutboxError(`github HTTP ${res.status}`), body: parsed };
    }
    return { ok: true, status: res.status, body: parsed };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      reason: safeOutboxError(err?.message || 'github fetch failed'),
      body: null,
    };
  }
}
