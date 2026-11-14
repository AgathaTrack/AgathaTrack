import { safeOutboxError } from './safeError.js';
import { githubRequest, parseSupportRepoSlug } from './githubHttp.js';
import { loadSupportIssueFieldCatalog } from './issueFieldCatalog.js';

function parseRepoSlug() {
  return parseSupportRepoSlug();
}

/**
 * @returns {Promise<{ ok: true, private: boolean } | { ok: false, reason: string }>}
 */
export async function fetchGithubRepoPrivacy() {
  const parsed = parseRepoSlug();
  if (!parsed) {
    return { ok: false, reason: 'SUPPORT_GITHUB_REPO unset or invalid' };
  }
  const { owner, repo } = parsed;
  const res = await githubRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
  );
  if (!res.ok) {
    if (res.status === 404) return { ok: false, reason: `repo not found (${res.status})` };
    if (res.status === 0) return { ok: false, reason: res.reason };
    return { ok: false, reason: `repo metadata HTTP ${res.status}` };
  }
  if (res.body?.private !== true) {
    return { ok: false, reason: 'repo is not private' };
  }
  return { ok: true, private: true };
}

function typeName(issue) {
  if (!issue) return null;
  if (typeof issue.type === 'string') return issue.type;
  if (issue.type && typeof issue.type.name === 'string') return issue.type.name;
  return null;
}

function readFieldValue(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.value === 'string' || typeof entry.value === 'number') return String(entry.value);
  const option = entry.single_select_option || entry.option;
  if (option && typeof option.name === 'string') return option.name;
  return null;
}

function readFieldId(entry) {
  const raw = entry?.field_id ?? entry?.issue_field_id ?? entry?.issue_field?.id;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function classificationMatches(issue, classification, fieldsByName) {
  if (typeName(issue) !== classification.type) return false;
  const present = new Map();
  const values = Array.isArray(issue?.issue_field_values) ? issue.issue_field_values : [];
  for (const entry of values) {
    const id = readFieldId(entry);
    const value = readFieldValue(entry);
    if (id !== null && value !== null) present.set(id, value);
  }
  return classification.fields.every((field) => {
    const id = fieldsByName.get(field.name)?.id;
    return id !== undefined && present.get(id) === field.value;
  });
}

/**
 * @returns {Promise<{ ok: true, number: number } | { ok: false, retryable: boolean, blocked?: boolean, message: string, status?: number, number?: number }>}
 */
export async function createGithubSupportIssue({ title, body, classification }) {
  const parsed = parseRepoSlug();
  if (!parsed) {
    return { ok: false, retryable: false, blocked: true, message: 'github repo not configured' };
  }
  if (!classification?.type || !Array.isArray(classification.fields)) {
    return { ok: false, retryable: false, message: 'unsupported ticket category' };
  }
  const catalog = await loadSupportIssueFieldCatalog();
  if (!catalog.ok) {
    return { ok: false, retryable: false, blocked: true, message: catalog.reason };
  }
  if (!catalog.types.has(classification.type)) {
    return { ok: false, retryable: false, blocked: true, message: `issue type missing: ${classification.type}` };
  }

  const issueFieldValues = [];
  for (const field of classification.fields) {
    const defined = catalog.fields.get(field.name);
    if (!defined || !defined.options.has(field.value)) {
      return {
        ok: false,
        retryable: false,
        blocked: true,
        message: `issue field option missing: ${field.name}`,
      };
    }
    issueFieldValues.push({ field_id: defined.id, value: field.value });
  }

  const { owner, repo } = parsed;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`;
  const res = await githubRequest(path, {
    method: 'POST',
    body: { title, body, type: classification.type, issue_field_values: issueFieldValues },
  });
  if (!res.ok) {
    return {
      ok: false,
      retryable: res.status >= 500 || res.status === 429 || res.status === 0,
      message: safeOutboxError(res.status ? `github create HTTP ${res.status}` : res.reason),
      status: res.status,
    };
  }
  const number = Number(res.body?.number);
  if (!Number.isFinite(number)) {
    return { ok: false, retryable: true, message: 'github create missing issue number' };
  }

  let issue = res.body;
  if (!classificationMatches(issue, classification, catalog.fields)) {
    const read = await githubRequest(`${path}/${number}`);
    if (read.ok) issue = read.body;
  }
  if (!classificationMatches(issue, classification, catalog.fields)) {
    return {
      ok: false,
      retryable: false,
      number,
      message: 'github issue missing classification',
      status: 201,
    };
  }
  return { ok: true, number };
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, retryable: boolean, message: string, status?: number }>}
 */
export async function redactGithubSupportIssue(issueNumber) {
  const parsed = parseRepoSlug();
  if (!parsed) {
    return { ok: false, retryable: false, message: 'github repo not configured' };
  }
  const { owner, repo } = parsed;
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`;
  const patch = await githubRequest(base, {
    method: 'PATCH',
    body: { title: '[removed]', body: '[removed]' },
  });
  if (!patch.ok) {
    return {
      ok: false,
      retryable: patch.status >= 500 || patch.status === 429 || patch.status === 0,
      message: safeOutboxError(patch.status ? `github patch HTTP ${patch.status}` : patch.reason),
      status: patch.status,
    };
  }
  const labelRes = await githubRequest(`${base}/labels`, {
    method: 'POST',
    body: ['redacted'],
  });
  if (labelRes.status === 422) {
    return {
      ok: false,
      retryable: false,
      message: safeOutboxError('github redacted label missing (422)'),
      status: 422,
    };
  }
  if (!labelRes.ok && labelRes.status !== 404) {
    return {
      ok: false,
      retryable: labelRes.status >= 500 || labelRes.status === 0,
      message: safeOutboxError(labelRes.status ? `github label HTTP ${labelRes.status}` : labelRes.reason),
      status: labelRes.status,
    };
  }
  return { ok: true };
}
