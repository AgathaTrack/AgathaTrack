'use strict';

const PAWPET_COLUMNS = [
  'Backlog',
  'To do',
  'In Analysis',
  'Ready',
  'In progress',
  'In Main',
  'In UAT',
  'Done',
];

const ATSUPPORT_COLUMNS = [
  'New',
  'Triaged',
  'Waiting on user',
  'In Progress',
  'Engineering done',
  'Done',
];

const SUPPORT_MIRROR_ISSUE_TYPES = ['Support Bug', 'Support Question'];

/**
 * Exact org `Stage` single-select spellings (GitHub rejects PATCH with wrong casing).
 * Board columns may differ case (`In Analysis` ↔ `In analysis`); matching is case-insensitive.
 */
const PAWPET_STAGE_ORG_FIELD_OPTIONS = [
  'Backlog',
  'To do',
  'In analysis',
  'Ready',
  'In progress',
  'In Main',
  'In UAT',
  'Done',
];

/** Org `Support Stage` options (ATSupport board only; scoped to support issue types in GitHub). */
const SUPPORT_STAGE_ORG_FIELD_OPTIONS = [
  'New',
  'Triaged',
  'Waiting on user',
  'In Progress',
  'Engineering done',
  'Done',
];

/** @deprecated Merged list kept for backward-compatible imports; mirror uses per-board lists. */
const STAGE_ORG_FIELD_OPTIONS = [
  ...PAWPET_STAGE_ORG_FIELD_OPTIONS,
  'New',
  'Triaged',
  'Waiting on user',
  'Engineering done',
];

function pawpetStageOrgFieldOptions() {
  return [...PAWPET_STAGE_ORG_FIELD_OPTIONS];
}

function supportStageOrgFieldOptions() {
  return [...SUPPORT_STAGE_ORG_FIELD_OPTIONS];
}

function stageOrgFieldOptions() {
  return [...STAGE_ORG_FIELD_OPTIONS];
}

function parseRepoSlug(slug) {
  const text = String(slug || '').trim();
  const parts = text.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function loadStageMirrorBoards({ defaultOwner, defaultRepo }) {
  const projectsPat = process.env.GH_PROJECTS_PAT;
  if (!projectsPat) {
    return { ok: false, reason: 'GH_PROJECTS_PAT unset' };
  }

  const pawpetProjectId = process.env.GH_PROJECT_ID;
  const pawpetStatusFieldId = process.env.GH_STATUS_FIELD_ID;
  const pawpetSyncedFieldId = process.env.GH_PAWPET_SYNCED_STAGE_FIELD_ID;
  const atsupportProjectId = process.env.GH_ATSUPPORT_PROJECT_ID || 'PVT_kwDOFUELss4BrnVN';
  const atsupportStatusFieldId =
    process.env.GH_ATSUPPORT_STATUS_FIELD_ID || 'PVTSSF_lADOFUELss4BrnVNzhp5O10';
  const atsupportSyncedFieldId = process.env.GH_ATSUPPORT_SYNCED_STAGE_FIELD_ID;
  const org = process.env.STAGE_MIRROR_ORG || defaultOwner || 'AgathaTrack';
  const atRepo =
    process.env.STAGE_ATSUPPORT_REPO || `${org}/AgathaTrackPrivate`;
  const atParsed = parseRepoSlug(atRepo);

  const missing = [];
  if (!pawpetProjectId) missing.push('GH_PROJECT_ID');
  if (!pawpetStatusFieldId) missing.push('GH_STATUS_FIELD_ID');
  if (!pawpetSyncedFieldId) missing.push('GH_PAWPET_SYNCED_STAGE_FIELD_ID');
  if (!atsupportSyncedFieldId) missing.push('GH_ATSUPPORT_SYNCED_STAGE_FIELD_ID');
  if (!atParsed) missing.push('STAGE_ATSUPPORT_REPO');
  if (missing.length > 0) {
    return { ok: false, reason: `Missing config: ${missing.join(', ')}` };
  }

  return {
    ok: true,
    org,
    boards: [
      {
        key: 'pawpet',
        label: 'Pawpet',
        projectId: pawpetProjectId,
        statusFieldId: pawpetStatusFieldId,
        syncedFieldId: pawpetSyncedFieldId,
        columns: PAWPET_COLUMNS,
        owner: defaultOwner,
        repo: defaultRepo,
        stageFieldName: 'Stage',
        stageFieldIdEnv: 'STAGE_ISSUE_FIELD_ID',
        staticStageOptions: pawpetStageOrgFieldOptions,
        supportIssueTypes: null,
      },
      {
        key: 'atsupport',
        label: 'ATSupport',
        projectId: atsupportProjectId,
        statusFieldId: atsupportStatusFieldId,
        syncedFieldId: atsupportSyncedFieldId,
        columns: ATSUPPORT_COLUMNS,
        owner: atParsed.owner,
        repo: atParsed.repo,
        stageFieldName: 'Support Stage',
        stageFieldIdEnv: 'SUPPORT_STAGE_ISSUE_FIELD_ID',
        staticStageOptions: supportStageOrgFieldOptions,
        supportIssueTypes: SUPPORT_MIRROR_ISSUE_TYPES,
      },
    ],
  };
}

module.exports = {
  PAWPET_COLUMNS,
  ATSUPPORT_COLUMNS,
  SUPPORT_MIRROR_ISSUE_TYPES,
  PAWPET_STAGE_ORG_FIELD_OPTIONS,
  SUPPORT_STAGE_ORG_FIELD_OPTIONS,
  pawpetStageOrgFieldOptions,
  supportStageOrgFieldOptions,
  stageOrgFieldOptions,
  loadStageMirrorBoards,
  parseRepoSlug,
};