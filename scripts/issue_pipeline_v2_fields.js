'use strict';

const { rest } = require('../.github/scripts/github-project-lib');

const FIELD_NAMES = {
  stage: 'Stage',
  blocked: 'Blocked',
  attempts: 'Attempts',
};

/** Optional. A missing name must not throw and must not be added to FIELD_NAMES. */
const OPTIONAL_FIELD_NAMES = {
  acceptance: 'Acceptance',
  acceptanceFailReason: 'Acceptance fail reason',
};

const CARRIED_KEYS = ['stage', 'blocked', 'attempts', 'acceptance', 'acceptanceFailReason'];

function fieldDef(def) {
  return {
    id: Number(def.id),
    name: def.name,
    options: (def.options || []).map((option) => option.name).filter(Boolean),
  };
}

function findOrgField(fields, name) {
  const key = name.toLowerCase();
  return (fields || []).find((field) => field?.name?.toLowerCase() === key) || null;
}

/**
 * Org issue-field definitions the engine uses. Throws when one is missing, so a renamed field
 * stops the tick instead of silently reading as empty.
 * Token: the Projects PAT (#2385 P1 token check).
 */
async function loadOrgFields({ org, token, restFn = rest }) {
  const defs = await restFn('GET', `/orgs/${encodeURIComponent(org)}/issue-fields`, token);
  const loaded = {};
  for (const [key, name] of Object.entries(FIELD_NAMES)) {
    const def = findOrgField(defs, name);
    if (!def?.id) {
      throw new Error(`Org issue field "${name}" not found for ${org}`);
    }
    loaded[key] = fieldDef(def);
  }
  for (const [key, name] of Object.entries(OPTIONAL_FIELD_NAMES)) {
    const def = findOrgField(defs, name);
    if (def?.id) loaded[key] = fieldDef(def);
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
  const parsed = {
    stage: entryText(byId.get(fields.stage.id)),
    blocked: entryText(byId.get(fields.blocked.id)),
    attempts: entryNumber(byId.get(fields.attempts.id)),
  };
  if (fields.acceptance) parsed.acceptance = entryText(byId.get(fields.acceptance.id)) || '';
  if (fields.acceptanceFailReason) {
    parsed.acceptanceFailReason = entryText(byId.get(fields.acceptanceFailReason.id)) || '';
  }
  return parsed;
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
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) delete merged[key];
  }
  for (const key of CARRIED_KEYS) {
    // A null write is a clear: the key was present, so the previous value is not copied back.
    if (!Object.prototype.hasOwnProperty.call(writes, key) && parsed?.[key]) {
      merged[key] = parsed[key];
    }
  }
  return merged;
}

/** PATCH payload for `issue_field_values` after carrying current parsed values the write omits. */
function buildIssueFieldPatch(fields, writes, parsed) {
  return buildFieldWrites(fields, withCurrentValues(parsed, writes));
}

/**
 * Apply field writes to one issue. `dryRun` only logs, so `dry-run` mode never writes.
 * A `Blocked` clear is a null write in `writes` (an engine release, PIPE-V2-D-HOLD-001).
 * Pass `parsed` so omitted fields are carried (PATCH replaces the whole value set).
 */
async function writeIssueFields({
  owner,
  repo,
  issueNumber,
  token,
  fields,
  writes,
  parsed,
  dryRun,
  restFn = rest,
  log = console.log,
}) {
  const merged = parsed ? withCurrentValues(parsed, writes) : writes;
  const payload = buildFieldWrites(fields, merged);
  if (dryRun) {
    log(JSON.stringify({ event: 'pipeline_v2_field_write', dry_run: true, issue: issueNumber, writes: merged }));
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
  buildIssueFieldPatch,
  withCurrentValues,
  writeIssueFields,
};
