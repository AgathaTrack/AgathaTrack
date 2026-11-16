'use strict';

const {
  listProjectIssues,
  updateProjectStatus,
  updateProjectItemTextField,
  assertProjectTextField,
  fetchIssue,
  graphql,
} = require('../.github/scripts/github-project-lib');
const { decideStageMirror } = require('./stage_mirror_decide');
const { loadStageMirrorBoards } = require('./stage_mirror_config');
const {
  loadOrgStageField,
  fetchIssueStage,
  setIssueStageField,
  resolveCanonicalOption,
  assertBoardColumnsMatchStageOptions,
} = require('./stage_mirror_fields');

function resolveMirrorMode() {
  const mode = String(process.env.STAGE_MIRROR || 'off').trim().toLowerCase();
  if (mode === 'on' || mode === 'dry-run' || mode === 'off') {
    return mode;
  }
  return 'off';
}

function logMirrorLine(boardKey, row, P, F, S, plan, dryRun) {
  const issue = row.issue;
  const repoSlug = issue.repository
    ? `${issue.repository.owner.login}/${issue.repository.name}`
    : 'unknown';
  const prefix = dryRun ? '[dry-run]' : '[live]';
  console.log(
    `${prefix} ${boardKey} item=${row.projectItemId} issue=${repoSlug}#${issue.number} P=${JSON.stringify(P || '')} F=${JSON.stringify(F || '')} S=${JSON.stringify(S || '')} action=${plan.action} reason=${plan.reason}`,
  );
}

async function applyMirrorPlan({
  board,
  row,
  plan,
  stageField,
  projectsPat,
  issueOwner,
  issueRepo,
  issueNum,
}) {
  if (plan.newS != null) {
    await updateProjectItemTextField({
      projectId: board.projectId,
      itemId: row.projectItemId,
      fieldId: board.syncedFieldId,
      text: plan.newS,
      projectsPat,
    });
  }

  if (plan.action === 'field_from_board') {
    const canonicalField = resolveCanonicalOption(plan.newF, stageField.options);
    if (!canonicalField) {
      throw new Error(`Cannot map board status to Stage field: ${plan.newF}`);
    }
    await setIssueStageField({
      owner: issueOwner,
      repo: issueRepo,
      issueNumber: issueNum,
      token: projectsPat,
      stageFieldId: stageField.id,
      value: canonicalField,
    });
    return;
  }

  if (plan.action === 'board_from_field') {
    const canonicalBoard = resolveCanonicalOption(plan.newP, board.columns);
    if (!canonicalBoard) {
      throw new Error(`Cannot map Stage field to board column: ${plan.newP}`);
    }
    const fullIssue = await fetchIssue(issueOwner, issueRepo, issueNum, projectsPat);
    await updateProjectStatus({
      issue: fullIssue,
      projectId: board.projectId,
      statusFieldId: board.statusFieldId,
      statusName: canonicalBoard,
      projectsPat,
    });
    return;
  }

  if (plan.action === 'sync_s') {
    return;
  }
}

async function reconcileBoard({
  board,
  stageField,
  projectsPat,
  dryRun,
  issueFilter,
}) {
  await assertProjectTextField(projectsPat, board.syncedFieldId, 'Synced stage');
  assertBoardColumnsMatchStageOptions(board.columns, stageField.options, board.label);

  const rows = await listProjectIssues({
    projectId: board.projectId,
    statusFieldId: board.statusFieldId,
    syncedFieldId: board.syncedFieldId,
    projectsPat,
  });

  const stats = { scanned: 0, writes: 0, noop: 0 };

  for (const row of rows) {
    const issueNum = row.issue.number;
    if (issueFilter != null && Number(issueFilter) !== Number(issueNum)) {
      continue;
    }
    const issueOwner = row.issue.repository?.owner?.login || board.owner;
    const issueRepo = row.issue.repository?.name || board.repo;

    stats.scanned += 1;
    const P = row.status || '';
    const S = row.syncedStage || '';
    const F =
      (await fetchIssueStage(issueOwner, issueRepo, issueNum, projectsPat, stageField.id)) || '';

    const plan = decideStageMirror(P, F, S, board.columns);
    if (plan.action === 'none') {
      stats.noop += 1;
      continue;
    }

    logMirrorLine(board.key, row, P, F, S, plan, dryRun);
    if (dryRun) {
      stats.writes += 1;
      continue;
    }

    await applyMirrorPlan({
      board,
      row,
      plan,
      stageField,
      projectsPat,
      issueOwner,
      issueRepo,
      issueNum,
    });
    stats.writes += 1;
  }

  return stats;
}

async function assertStageFieldOptions(projectsPat, statusFieldId, columns, boardLabel) {
  const data = await graphql(
    projectsPat,
    `query($fieldId: ID!) {
      node(id: $fieldId) {
        ... on ProjectV2SingleSelectField {
          options { name }
        }
      }
    }`,
    { fieldId: statusFieldId },
  );
  const options = (data.node?.options || []).map((option) => option.name);
  const missing = columns.filter(
    (column) => !options.some((option) => option.toLowerCase() === column.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new Error(`${boardLabel} Status field missing columns: ${missing.join(', ')}`);
  }
}

async function runStageMirror() {
  const mode = resolveMirrorMode();
  if (mode === 'off') {
    console.log('STAGE_MIRROR=off; exiting');
    return { ok: true, skipped: true };
  }

  const repository = process.env.GITHUB_REPOSITORY || 'AgathaTrack/AgathaTrack';
  const [owner, repo] = repository.split('/');
  const dryRun = mode === 'dry-run' || process.env.STAGE_MIRROR_DRY_RUN === 'true';
  const config = loadStageMirrorBoards({ defaultOwner: owner, defaultRepo: repo });
  if (!config.ok) {
    throw new Error(`Stage mirror config invalid: ${config.reason}`);
  }

  const projectsPat = process.env.GH_PROJECTS_PAT;
  const stageField = await loadOrgStageField({ org: config.org, token: projectsPat });

  for (const board of config.boards) {
    await assertStageFieldOptions(
      projectsPat,
      board.statusFieldId,
      board.columns,
      board.label,
    );
  }

  const issueFilter = process.env.ISSUE_NUMBER ? Number(process.env.ISSUE_NUMBER) : null;
  const totals = { scanned: 0, writes: 0, noop: 0 };

  for (const board of config.boards) {
    const stats = await reconcileBoard({
      board,
      stageField,
      projectsPat,
      dryRun,
      issueFilter,
    });
    totals.scanned += stats.scanned;
    totals.writes += stats.writes;
    totals.noop += stats.noop;
  }

  console.log(
    `stage-mirror complete mode=${mode} dry_run=${dryRun} scanned=${totals.scanned} writes=${totals.writes} noop=${totals.noop}`,
  );
  return { ok: true, dryRun, totals };
}

if (require.main === module) {
  runStageMirror().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  resolveMirrorMode,
  reconcileBoard,
  applyMirrorPlan,
  runStageMirror,
};