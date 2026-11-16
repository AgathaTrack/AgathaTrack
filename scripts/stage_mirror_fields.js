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

async function loadOrgStageField({ org, token }) {
  const fromEnv = loadOrgStageFieldFromEnv();
  if (fromEnv) {
    return fromEnv;
  }
  const fields = await rest('GET', `/orgs/${encodeURIComponent(org)}/issue-fields`, token);
  const stage = (fields || []).find(
    (field) => field?.name?.toLowerCase() === STAGE_FIELD_NAME.toLowerCase(),
  );
  if (!stage?.id) {
    throw new Error(`Org issue field "${STAGE_FIELD_NAME}" not found for ${org}`);
  }
  const options = (stage.options || []).map((option) => option.name).filter(Boolean);
  if (options.length === 0) {
    throw new Error(`Org issue field "${STAGE_FIELD_NAME}" has no options`);
  }
  return { id: Number(stage.id), options, name: stage.name };
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