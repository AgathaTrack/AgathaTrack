'use strict';

const { rest } = require('../.github/scripts/github-project-lib');
const { pawpetStageOrgFieldOptions, supportStageOrgFieldOptions } = require('./stage_mirror_config');

const STAGE_FIELD_NAME = 'Stage';
const SUPPORT_STAGE_FIELD_NAME = 'Support Stage';

function githubRestErrorStatus(err) {
  const match = /failed \((\d{3})\):/.exec(String(err?.message || ''));
  return match ? Number(match[1]) : null;
}

function isOrgIssueFieldsReadRefused(err) {
  return githubRestErrorStatus(err) === 403;
}

function readIssueFieldStageName(entry) {
  if (!entry) {
    return null;
  }
  const option = entry.single_select_option || entry.option;
  if (option?.name) {
    return option.name;
  }
  if (typeof entry.value === 'string' && entry.data_type !== 'single_select') {
    return entry.value;
  }
  return null;
}

function findFieldValueById(issueFieldValues, fieldId) {
  const values = issueFieldValues || [];
  for (const entry of values) {
    const id = Number(entry?.field_id ?? entry?.issue_field_id ?? entry?.issue_field?.id);
    if (Number.isFinite(fieldId) && id === fieldId) {
      return readIssueFieldStageName(entry);
    }
  }
  return null;
}

function loadOrgMirrorFieldIdFromEnv(envVarName) {
  const rawId = process.env[envVarName];
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  return id;
}

function loadOrgStageFieldFromEnv() {
  const id = loadOrgMirrorFieldIdFromEnv('STAGE_ISSUE_FIELD_ID');
  if (!id) {
    return null;
  }
  const options = pawpetStageOrgFieldOptions();
  return { id, options, name: STAGE_FIELD_NAME };
}

function orgIssueFieldsPath(org) {
  return `/orgs/${encodeURIComponent(org)}/issue-fields`;
}

function actionableOrgIssueFieldsError(err, org, fieldName, envVarName) {
  const endpoint = `GET ${orgIssueFieldsPath(org)}`;
  return new Error(
    `${err.message}\n` +
      `GH_PROJECTS_PAT must have read access to organisation issue fields (${endpoint}); ` +
      `grant the organisation issue fields: read permission to the GH_PROJECTS_PAT identity, ` +
      `or set ${envVarName} so a 403 falls back to the static option list.`,
    { cause: err },
  );
}

/**
 * Read an org single-select issue field used by the stage mirror for one board.
 */
async function loadOrgMirrorField({
  org,
  token,
  fieldName,
  staticOptions,
  envVarName,
  warn = console.warn,
  getIssueFields = null,
}) {
  const envId = loadOrgMirrorFieldIdFromEnv(envVarName);
  const fetchFields = getIssueFields || (() => rest('GET', orgIssueFieldsPath(org), token));
  let fields;
  try {
    fields = await fetchFields();
  } catch (err) {
    if (!envId || !isOrgIssueFieldsReadRefused(err)) {
      throw actionableOrgIssueFieldsError(err, org, fieldName, envVarName);
    }
    warn(
      `[warn] org ${fieldName} options not verified (${err.message}); using ${envVarName} and the static option list`,
    );
    return {
      id: envId,
      options: staticOptions(),
      name: fieldName,
      optionsVerified: false,
    };
  }
  const match = (fields || []).find(
    (field) => field?.name?.toLowerCase() === fieldName.toLowerCase(),
  );
  if (!match?.id) {
    throw new Error(`Org issue field "${fieldName}" not found for ${org}`);
  }
  if (envId && Number(match.id) !== envId) {
    throw new Error(`${envVarName}=${envId} does not match org ${fieldName} field id ${match.id}`);
  }
  const options = (match.options || []).map((option) => option.name).filter(Boolean);
  if (options.length === 0) {
    throw new Error(`Org issue field "${fieldName}" has no options`);
  }
  return { id: Number(match.id), options, name: match.name, optionsVerified: true };
}

async function loadOrgStageField(args) {
  return loadOrgMirrorField({
    org: args.org,
    token: args.token,
    fieldName: STAGE_FIELD_NAME,
    staticOptions: pawpetStageOrgFieldOptions,
    envVarName: 'STAGE_ISSUE_FIELD_ID',
    warn: args.warn,
    getIssueFields: args.getIssueFields,
  });
}

async function loadOrgSupportStageField(args) {
  return loadOrgMirrorField({
    org: args.org,
    token: args.token,
    fieldName: SUPPORT_STAGE_FIELD_NAME,
    staticOptions: supportStageOrgFieldOptions,
    envVarName: 'SUPPORT_STAGE_ISSUE_FIELD_ID',
    warn: args.warn,
    getIssueFields: args.getIssueFields,
  });
}

async function loadBoardMirrorField(board, args) {
  if (board.stageFieldName === SUPPORT_STAGE_FIELD_NAME) {
    return loadOrgSupportStageField(args);
  }
  return loadOrgStageField(args);
}

async function fetchIssueForMirror(owner, repo, issueNumber, token, stageFieldId) {
  const issue = await rest(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
  );
  return {
    stage: findFieldValueById(issue?.issue_field_values, stageFieldId) || '',
    typeName: issue?.type?.name || '',
  };
}

async function fetchIssueStage(owner, repo, issueNumber, token, stageFieldId) {
  const issue = await rest(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
  );
  return findFieldValueById(issue?.issue_field_values, stageFieldId) || '';
}

function entryToPatchValue(entry) {
  const select = readIssueFieldStageName(entry);
  if (select != null && select !== '') {
    return select;
  }
  const raw = entry?.value;
  if (raw != null && raw !== '') {
    return raw;
  }
  return null;
}

/**
 * Issue-field PATCH replaces the whole value set. Carry existing values and apply `set`; omit
 * field ids in `omitFieldIds` so they are cleared.
 */
function buildCarriedIssueFieldPatch(issueFieldValues, { set = [], omitFieldIds = [] } = {}) {
  const omit = new Set(omitFieldIds.map((id) => Number(id)));
  const setById = new Map(set.map(({ field_id, value }) => [Number(field_id), value]));
  const payload = [];
  const written = new Set();

  for (const entry of issueFieldValues || []) {
    const id = Number(entry?.field_id ?? entry?.issue_field_id ?? entry?.issue_field?.id);
    if (!Number.isFinite(id)) {
      continue;
    }
    if (omit.has(id)) {
      continue;
    }
    if (setById.has(id)) {
      payload.push({ field_id: id, value: setById.get(id) });
      written.add(id);
      continue;
    }
    const carried = entryToPatchValue(entry);
    if (carried === null) {
      continue;
    }
    payload.push({ field_id: id, value: carried });
  }
  for (const [id, value] of setById) {
    if (!written.has(id)) {
      payload.push({ field_id: id, value });
    }
  }
  return payload;
}

async function setIssueStageField({ owner, repo, issueNumber, token, stageFieldId, value }) {
  const issue = await rest(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
  );
  const issueFieldValues = buildCarriedIssueFieldPatch(issue.issue_field_values, {
    set: [{ field_id: stageFieldId, value }],
  });
  await rest(
    'PATCH',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
    { issue_field_values: issueFieldValues },
  );
}

function resolveCanonicalOption(name, options) {
  if (!name) {
    return null;
  }
  const key = String(name).trim().toLowerCase();
  return options.find((option) => String(option).trim().toLowerCase() === key) || null;
}

function assertBoardColumnsMatchStageOptions(
  boardColumns,
  stageOptions,
  boardLabel,
  fieldName = STAGE_FIELD_NAME,
) {
  const missing = [];
  for (const column of boardColumns) {
    if (!resolveCanonicalOption(column, stageOptions)) {
      missing.push(column);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${boardLabel} Status columns missing from org ${fieldName} options: ${missing.join(', ')}`,
    );
  }
}

module.exports = {
  STAGE_FIELD_NAME,
  SUPPORT_STAGE_FIELD_NAME,
  githubRestErrorStatus,
  isOrgIssueFieldsReadRefused,
  loadOrgStageFieldFromEnv,
  loadOrgStageField,
  loadOrgSupportStageField,
  loadOrgMirrorField,
  loadBoardMirrorField,
  fetchIssueStage,
  fetchIssueForMirror,
  setIssueStageField,
  buildCarriedIssueFieldPatch,
  entryToPatchValue,
  findFieldValueById,
  readIssueFieldStageName,
  resolveCanonicalOption,
  assertBoardColumnsMatchStageOptions,
};