'use strict';

const { rest } = require('../.github/scripts/github-project-lib');

const FIELD_NAMES = {
  stage: 'Stage',
  blocked: 'Blocked',
  attempts: 'Attempts',
};

function findOrgField(fields, name) {
  const key = name.toLowerCase();
  return (fields || []).find((field) => field?.name?.toLowerCase() === key) || null;
}

/**
 * Org issue-field definitions the engine uses. Throws when one is missing, so a renamed field
 * stops the tick instead of silently reading as empty.
 * Token: the Projects PAT, as the stage mirror uses today (#2385 P1 token check).
 */
async function loadOrgFields({ org, token, restFn = rest }) {
  const defs = await restFn('GET', `/orgs/${encodeURIComponent(org)}/issue-fields`, token);
  const loaded = {};
  for (const [key, name] of Object.entries(FIELD_NAMES)) {
    const def = findOrgField(defs, name);
    if (!def?.id) {
      throw new Error(`Org issue field "${name}" not found for ${org}`);
    }
    loaded[key] = {
      id: Number(def.id),
      name: def.name,
      options: (def.options || []).map((option) => option.name).filter(Boolean),
    };
  }
  return loaded;
}

function entryFieldId(entry) {
  return Number(entry?.field_id ?? entry?.issue_field_id ?? entry?.issue_field?.id);
}

function entryText(entry) {
  const option = entry?.single_select_option || entry?.option;
  if (option?.name) {
    return option.name;
  }
  return typeof entry?.value === 'string' ? entry.value : '';
}

function entryNumber(entry) {
  const value = Number(entry?.value);
  return Number.isFinite(value) ? value : 0;
}

/** Parse an issue's `issue_field_values` into the three engine fields. */
function parseIssueFields(issue, fields) {
  const values = issue?.issue_field_values || [];
  const byId = new Map(values.map((entry) => [entryFieldId(entry), entry]));
  return {
    stage: entryText(byId.get(fields.stage.id)),
    blocked: entryText(byId.get(fields.blocked.id)),
    attempts: entryNumber(byId.get(fields.attempts.id)),
  };
}

function canonicalOption(field, value) {
  const key = String(value).trim().toLowerCase();
  return field.options.find((option) => option.toLowerCase() === key) || null;
}

/**
 * Build the PATCH payload entries for an action's writes. Single-selects must name an existing
 * option, so a typo in the engine fails here and not in production.
 */
function buildFieldWrites(fields, writes) {
  return Object.entries(writes).map(([key, value]) => {
    const field = fields[key];
    if (!field) {
      throw new Error(`Unknown engine field "${key}"`);
    }
    if (field.options.length > 0) {
      const option = canonicalOption(field, value);
      if (!option) {
        throw new Error(`"${value}" is not an option of ${field.name}`);
      }
      return { field_id: field.id, value: option };
    }
    return { field_id: field.id, value };
  });
}

/**
 * The issue-fields PATCH replaces the issue's whole value set: a field left out of the payload is
 * removed (a launch that wrote only Attempts wiped Stage). So every write carries the values the
 * issue already holds. Keys in `writes` come first and win; empty or zero current values are
 * skipped, which is the same as the field being unset.
 */
function withCurrentValues(parsed, writes) {
  const merged = { ...writes };
  for (const key of Object.keys(FIELD_NAMES)) {
    if (!(key in merged) && parsed?.[key]) {
      merged[key] = parsed[key];
    }
  }
  return merged;
}

/**
 * Apply field writes to one issue. `dryRun` only logs, so `dry-run` mode never writes.
 * The engine never clears `Blocked`, so there is deliberately no clear operation.
 */
async function writeIssueFields({
  owner,
  repo,
  issueNumber,
  token,
  fields,
  writes,
  dryRun,
  restFn = rest,
  log = console.log,
}) {
  const payload = buildFieldWrites(fields, writes);
  if (dryRun) {
    log(JSON.stringify({ event: 'pipeline_v2_field_write', dry_run: true, issue: issueNumber, writes }));
    return { dryRun: true, payload };
  }
  await restFn(
    'PATCH',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
    { issue_field_values: payload },
  );
  return { dryRun: false, payload };
}

module.exports = {
  FIELD_NAMES,
  loadOrgFields,
  parseIssueFields,
  buildFieldWrites,
  withCurrentValues,
  writeIssueFields,
};
