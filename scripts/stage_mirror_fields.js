'use strict';

const { rest } = require('../.github/scripts/github-project-lib');
const { stageOrgFieldOptions } = require('./stage_mirror_config');

const STAGE_FIELD_NAME = 'Stage';

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

/**
 * Read the org Stage field. The real option list is read first, so a missing or renamed option fails
 * at start-up. Only when that read is refused (the projects PAT has no org issue-field read, see
 * #2375) does it fall back to the id in STAGE_ISSUE_FIELD_ID with the static option list, and that
 * fallback logs a warning every run: the options are then unverified.
 */
async function loadOrgStageField({ org, token, warn = console.warn }) {
  const envId = loadOrgStageFieldFromEnv()?.id ?? null;
  let fields;
  try {
    fields = await rest('GET', `/orgs/${encodeURIComponent(org)}/issue-fields`, token);
  } catch (err) {
    if (!envId) {
      throw err;
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
  loadOrgStageFieldFromEnv,
  loadOrgStageField,
  fetchIssueStage,
  setIssueStageField,
  findFieldValueById,
  readIssueFieldStageName,
  resolveCanonicalOption,
  assertBoardColumnsMatchStageOptions,
};