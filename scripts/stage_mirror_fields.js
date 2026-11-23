'use strict';

const { rest } = require('../.github/scripts/github-project-lib');
const { stageOrgFieldOptions } = require('./stage_mirror_config');

const STAGE_FIELD_NAME = 'Stage';

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

function loadOrgStageFieldFromEnv() {
  const rawId = process.env.STAGE_ISSUE_FIELD_ID;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  const options = stageOrgFieldOptions();
  return { id, options, name: STAGE_FIELD_NAME };
}

function orgIssueFieldsPath(org) {
  return `/orgs/${encodeURIComponent(org)}/issue-fields`;
}

/**
 * Re-throw a failed org issue-field read with the secret, endpoint and permission that are missing.
 * The original `failed (<status>):` text is kept so githubRestErrorStatus still parses the status.
 */
function actionableOrgIssueFieldsError(err, org) {
  const endpoint = `GET ${orgIssueFieldsPath(org)}`;
  return new Error(
    `${err.message}\n` +
      `GH_PROJECTS_PAT must have read access to organisation issue fields (${endpoint}); ` +
      `grant the organisation issue fields: read permission to the GH_PROJECTS_PAT identity, ` +
      `or set STAGE_ISSUE_FIELD_ID so a 403 falls back to the static option list.`,
    { cause: err },
  );
}

/**
 * Read the org Stage field. The real option list is read first, so a missing or renamed option fails
 * at start-up. Only when that read is refused (the projects PAT has no org issue-field read, see
 * #2375) does it fall back to the id in STAGE_ISSUE_FIELD_ID with the static option list, and that
 * fallback logs a warning every run: the options are then unverified. Auth, configuration, and
 * transient API errors are not eligible for that fallback (HTTP 403 only).
 */
async function loadOrgStageField({ org, token, warn = console.warn, getIssueFields = null }) {
  const envId = loadOrgStageFieldFromEnv()?.id ?? null;
  const fetchFields = getIssueFields || (() => rest('GET', orgIssueFieldsPath(org), token));
  let fields;
  try {
    fields = await fetchFields();
  } catch (err) {
    if (!envId || !isOrgIssueFieldsReadRefused(err)) {
      throw actionableOrgIssueFieldsError(err, org);
    }
    warn(
      `[warn] org Stage options not verified (${err.message}); using STAGE_ISSUE_FIELD_ID and the static option list`,
    );
    return { id: envId, options: stageOrgFieldOptions(), name: STAGE_FIELD_NAME, optionsVerified: false };
  }
  const stage = (fields || []).find(
    (field) => field?.name?.toLowerCase() === STAGE_FIELD_NAME.toLowerCase(),
  );
  if (!stage?.id) {
    throw new Error(`Org issue field "${STAGE_FIELD_NAME}" not found for ${org}`);
  }
  if (envId && Number(stage.id) !== envId) {
    throw new Error(`STAGE_ISSUE_FIELD_ID=${envId} does not match org Stage field id ${stage.id}`);
  }
  const options = (stage.options || []).map((option) => option.name).filter(Boolean);
  if (options.length === 0) {
    throw new Error(`Org issue field "${STAGE_FIELD_NAME}" has no options`);
  }
  return { id: Number(stage.id), options, name: stage.name, optionsVerified: true };
}

async function fetchIssueStage(owner, repo, issueNumber, token, stageFieldId) {
  const issue = await rest(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
  );
  return findFieldValueById(issue?.issue_field_values, stageFieldId) || '';
}

async function setIssueStageField({ owner, repo, issueNumber, token, stageFieldId, value }) {
  await rest('PATCH', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`, token, {
    issue_field_values: [{ field_id: stageFieldId, value }],
  });
}

function resolveCanonicalOption(name, options) {
  if (!name) {
    return null;
  }
  const key = String(name).trim().toLowerCase();
  return options.find((option) => String(option).trim().toLowerCase() === key) || null;
}

function assertBoardColumnsMatchStageOptions(boardColumns, stageOptions, boardLabel) {
  const missing = [];
  for (const column of boardColumns) {
    if (!resolveCanonicalOption(column, stageOptions)) {
      missing.push(column);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `${boardLabel} Status columns missing from org Stage options: ${missing.join(', ')}`,
    );
  }
}

module.exports = {
  STAGE_FIELD_NAME,
  githubRestErrorStatus,
  isOrgIssueFieldsReadRefused,
  loadOrgStageFieldFromEnv,
  loadOrgStageField,
  fetchIssueStage,
  setIssueStageField,
  findFieldValueById,
  readIssueFieldStageName,
  resolveCanonicalOption,
  assertBoardColumnsMatchStageOptions,
};