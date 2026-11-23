'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  githubRestErrorStatus,
  isOrgIssueFieldsReadRefused,
  loadOrgStageField,
} = require('./stage_mirror_fields');

const ISSUE_FIELDS_PATH = '/orgs/AgathaTrack/issue-fields';

async function withStageIssueFieldId(value, fn) {
  const prev = process.env.STAGE_ISSUE_FIELD_ID;
  if (value === undefined) {
    delete process.env.STAGE_ISSUE_FIELD_ID;
  } else {
    process.env.STAGE_ISSUE_FIELD_ID = value;
  }
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.STAGE_ISSUE_FIELD_ID;
    } else {
      process.env.STAGE_ISSUE_FIELD_ID = prev;
    }
  }
}

function refusingIssueFields(status, body = 'nope') {
  return async () => {
    throw new Error(`GitHub REST GET ${ISSUE_FIELDS_PATH} failed (${status}): ${body}`);
  };
}

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

test('loadOrgStageField: 404 fails the run and names the secret, endpoint and permission', async () => {
  await withStageIssueFieldId(undefined, async () => {
    const warnings = [];
    const err = await loadOrgStageField({
      org: 'AgathaTrack',
      token: 't',
      warn: (line) => warnings.push(line),
      getIssueFields: refusingIssueFields(404, 'Not Found'),
    }).then(
      () => assert.fail('expected rejection'),
      (e) => e,
    );
    assert.match(err.message, /GH_PROJECTS_PAT/);
    assert.match(err.message, /GET \/orgs\/AgathaTrack\/issue-fields/);
    assert.match(err.message, /organisation issue fields: read/);
    assert.equal(githubRestErrorStatus(err), 404);
    assert.equal(warnings.length, 0);
  });
});

test('loadOrgStageField: 404 still fails with STAGE_ISSUE_FIELD_ID set (no fallback)', async () => {
  await withStageIssueFieldId('49916872', async () => {
    const warnings = [];
    await assert.rejects(
      loadOrgStageField({
        org: 'AgathaTrack',
        token: 't',
        warn: (line) => warnings.push(line),
        getIssueFields: refusingIssueFields(404, 'Not Found'),
      }),
      (err) => {
        assert.match(err.message, /GH_PROJECTS_PAT/);
        assert.equal(githubRestErrorStatus(err), 404);
        return true;
      },
    );
    assert.equal(warnings.length, 0);
  });
});

test('loadOrgStageField: 403 without STAGE_ISSUE_FIELD_ID fails with the actionable message', async () => {
  await withStageIssueFieldId(undefined, async () => {
    await assert.rejects(
      loadOrgStageField({
        org: 'AgathaTrack',
        token: 't',
        getIssueFields: refusingIssueFields(403, 'forbidden'),
      }),
      (err) => {
        assert.match(err.message, /GH_PROJECTS_PAT/);
        assert.equal(githubRestErrorStatus(err), 403);
        return true;
      },
    );
  });
});

test('loadOrgStageField: 503 with STAGE_ISSUE_FIELD_ID still rethrows (no fallback)', async () => {
  await withStageIssueFieldId('49916872', async () => {
    await assert.rejects(
      loadOrgStageField({
        org: 'AgathaTrack',
        token: 't',
        getIssueFields: refusingIssueFields(503, 'busy'),
      }),
      (err) => {
        assert.match(err.message, /503/);
        assert.match(err.message, /GH_PROJECTS_PAT/);
        assert.equal(githubRestErrorStatus(err), 503);
        return true;
      },
    );
  });
});

test('loadOrgStageField: a successful read returns the verified option list', async () => {
  await withStageIssueFieldId(undefined, async () => {
    const field = await loadOrgStageField({
      org: 'AgathaTrack',
      token: 't',
      getIssueFields: async () => [
        { id: 49916872, name: 'Stage', options: [{ name: 'To do' }, { name: 'Done' }] },
      ],
    });
    assert.equal(field.id, 49916872);
    assert.equal(field.optionsVerified, true);
    assert.deepEqual(field.options, ['To do', 'Done']);
  });
});
