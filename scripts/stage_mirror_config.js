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

/**
 * Exact org `Stage` single-select spellings (GitHub rejects PATCH with wrong casing).
 * Board columns may differ case (`In Analysis` ↔ `In analysis`); matching is case-insensitive.
 */
const STAGE_ORG_FIELD_OPTIONS = [
  'Backlog',
  'To do',
  'In analysis',
  'Ready',
  'In progress',
  'In Main',
  'In UAT',
  'Done',
  'New',
  'Triaged',
  'Waiting on user',
  'Engineering done',
];

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
      },
    ],
  };
}

module.exports = {
  PAWPET_COLUMNS,
  ATSUPPORT_COLUMNS,
  stageOrgFieldOptions,
  loadStageMirrorBoards,
  parseRepoSlug,
};