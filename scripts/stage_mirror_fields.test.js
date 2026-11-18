'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  githubRestErrorStatus,
  isOrgIssueFieldsReadRefused,
  loadOrgStageField,
} = require('./stage_mirror_fields');

test('githubRestErrorStatus parses REST error messages', () => {
  assert.equal(
    githubRestErrorStatus(new Error('GitHub REST GET /orgs/x/issue-fields failed (403): forbidden')),
    403,
  );
  assert.equal(githubRestErrorStatus(new Error('other')), null);
});

test('isOrgIssueFieldsReadRefused is true only for HTTP 403', () => {
  assert.equal(
    isOrgIssueFieldsReadRefused(
      new Error('GitHub REST GET /orgs/x/issue-fields failed (403): forbidden'),
    ),
    true,
  );
  assert.equal(
    isOrgIssueFieldsReadRefused(
      new Error('GitHub REST GET /orgs/x/issue-fields failed (401): bad'),
    ),
    false,
  );
  assert.equal(
    isOrgIssueFieldsReadRefused(
      new Error('GitHub REST GET /orgs/x/issue-fields failed (503): busy'),
    ),
    false,
  );
});

test('loadOrgStageField: falls back on 403 when STAGE_ISSUE_FIELD_ID is set', async () => {
  const prev = process.env.STAGE_ISSUE_FIELD_ID;
  process.env.STAGE_ISSUE_FIELD_ID = '49916872';
  const warnings = [];
  try {
    const field = await loadOrgStageField({
      org: 'AgathaTrack',
      token: 't',
      warn: (line) => warnings.push(line),
      getIssueFields: async () => {
        throw new Error('GitHub REST GET /orgs/AgathaTrack/issue-fields failed (403): forbidden');
      },
    });
    assert.equal(field.id, 49916872);
    assert.equal(field.optionsVerified, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /org Stage options not verified/);
  } finally {
    if (prev === undefined) {
      delete process.env.STAGE_ISSUE_FIELD_ID;
    } else {
      process.env.STAGE_ISSUE_FIELD_ID = prev;
    }
  }
});

test('loadOrgStageField: rethrows 401 even when STAGE_ISSUE_FIELD_ID is set', async () => {
  const prev = process.env.STAGE_ISSUE_FIELD_ID;
  process.env.STAGE_ISSUE_FIELD_ID = '49916872';
  try {
    await assert.rejects(
      loadOrgStageField({
        org: 'AgathaTrack',
        token: 't',
        getIssueFields: async () => {
          throw new Error('GitHub REST GET /orgs/AgathaTrack/issue-fields failed (401): unauthorized');
        },
      }),
      /401/,
    );
  } finally {
    if (prev === undefined) {
      delete process.env.STAGE_ISSUE_FIELD_ID;
    } else {
      process.env.STAGE_ISSUE_FIELD_ID = prev;
    }
  }
});