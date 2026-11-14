import { logger } from '../../logger.js';
import { isGithubOutboxEnabled } from './config.js';
import { githubRequest, parseSupportRepoSlug } from './githubHttp.js';

const REQUIRED_TYPES = ['Support Bug', 'Support Question'];

const REQUIRED_FIELDS = {
  'Support Category': ['Suggestion', 'Account', 'Billing'],
  Environment: ['UAT', 'Prod'],
  Source: ['form'],
  'Website or App': ['Website'],
};

const CATALOG_TTL_MS = 60_000;
let cachedCatalog = null;
let cachedAt = 0;

/** @internal test helper */
export function resetSupportIssueFieldCatalogForTests() {
  cachedCatalog = null;
  cachedAt = 0;
}

function repoOwner() {
  return parseSupportRepoSlug()?.owner || null;
}

function optionNames(field) {
  const options = Array.isArray(field?.options) ? field.options : [];
  return new Set(options.map((option) => option?.name).filter(Boolean));
}

/**
 * @returns {Promise<{ ok: true, types: Set<string>, fields: Map<string, { id: number, options: Set<string> }> } | { ok: false, reason: string }>}
 */
export async function loadSupportIssueFieldCatalog() {
  if (cachedCatalog && Date.now() - cachedAt < CATALOG_TTL_MS) return cachedCatalog;
  const owner = repoOwner();
  if (!owner) {
    return { ok: false, reason: 'SUPPORT_GITHUB_REPO unset or invalid' };
  }

  const typesRes = await githubRequest(`/orgs/${encodeURIComponent(owner)}/issue-types`);
  if (!typesRes.ok) {
    return { ok: false, reason: `issue types HTTP ${typesRes.status}` };
  }
  const types = new Set(
    (Array.isArray(typesRes.body) ? typesRes.body : [])
      .filter((type) => type?.is_enabled !== false && type?.name)
      .map((type) => type.name),
  );
  for (const name of REQUIRED_TYPES) {
    if (!types.has(name)) {
      return { ok: false, reason: `issue type missing: ${name}` };
    }
  }

  const fieldsRes = await githubRequest(`/orgs/${encodeURIComponent(owner)}/issue-fields`);
  if (!fieldsRes.ok) {
    return { ok: false, reason: `issue fields HTTP ${fieldsRes.status}` };
  }
  const fields = new Map();
  for (const field of Array.isArray(fieldsRes.body) ? fieldsRes.body : []) {
    if (field?.name && Number.isFinite(Number(field.id))) {
      fields.set(field.name, { id: Number(field.id), options: optionNames(field) });
    }
  }
  for (const [name, requiredOptions] of Object.entries(REQUIRED_FIELDS)) {
    const field = fields.get(name);
    if (!field) {
      return { ok: false, reason: `issue field missing: ${name}` };
    }
    for (const option of requiredOptions) {
      if (!field.options.has(option)) {
        return { ok: false, reason: `issue field option missing: ${name} ${option}` };
      }
    }
  }

  cachedCatalog = { ok: true, types, fields };
  cachedAt = Date.now();
  return cachedCatalog;
}

/**
 * Block create-issue rows when the org catalog cannot satisfy R-023.
 * A later successful read returns those rows to pending.
 *
 * @param {import('pg').Pool} pool
 */
export async function refreshSupportIssueCatalogGate(pool) {
  if (!isGithubOutboxEnabled()) return;

  const catalog = await loadSupportIssueFieldCatalog();
  if (!catalog.ok) {
    const blocked = await pool.query(
      `UPDATE support_outbox
       SET status = 'blocked',
           last_error = $1,
           updated_at = now()
       WHERE kind = 'github_issue'
         AND status IN ('pending', 'failed')
         AND next_attempt_at <= now()`,
      [catalog.reason],
    );
    if (blocked.rowCount > 0) {
      logger.warn(
        { count: blocked.rowCount, reason: catalog.reason },
        'support outbox: create-issue rows blocked (issue catalog)',
      );
    }
    return;
  }

  const unblocked = await pool.query(
    `UPDATE support_outbox
     SET status = 'pending',
         next_attempt_at = now(),
         last_error = NULL,
         updated_at = now()
     WHERE kind = 'github_issue'
       AND status = 'blocked'
       AND last_error LIKE 'issue %'`,
  );
  if (unblocked.rowCount > 0) {
    logger.info(
      { count: unblocked.rowCount },
      'support outbox: catalog-blocked create-issue rows returned to pending',
    );
  }
}
