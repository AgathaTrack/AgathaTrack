'use strict';

const {
  listProjectIssues,
  updateProjectStatus,
  updateProjectItemTextField,
  assertProjectTextField,
  fetchIssue,
  graphql,
} = require('../.github/scripts/github-project-lib');
const { inEngineScope, labelNames, v2OwnsLazy } = require('../.github/scripts/pipeline-v2-owner');
const { decideStageMirror } = require('./stage_mirror_decide');
const { loadStageMirrorBoards } = require('./stage_mirror_config');
const {
  loadBoardMirrorField,
  fetchIssueForMirror,
  setIssueStageField,
  resolveCanonicalOption,
  assertBoardColumnsMatchStageOptions,
} = require('./stage_mirror_fields');

const defaultIo = {
  updateProjectItemTextField,
  updateProjectStatus,
  setIssueStageField,
  fetchIssue,
};

function resolveMirrorMode() {
  const mode = String(process.env.STAGE_MIRROR || 'off').trim().toLowerCase();
  if (mode === 'on' || mode === 'dry-run' || mode === 'off') {
    return mode;
  }
  return 'off';
}

// Repo and number only: never the title or body of an issue (ATSupport issues are private).
function rowRef(row) {
  const issue = row.issue || {};
  return `${issue.repository?.name || 'unknown'}#${issue.number}`;
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

/**
 * Apply one plan. The target write (Stage field or board column) goes first and the synced value S
 * goes last. If the target write fails, S keeps its old value, so the next pass sees the same change
 * again and retries it. Writing S first would make a failed write look like a human edit on the next
 * pass, and that pass would revert the human's change.
 */
async function applyMirrorPlan(
  { board, row, plan, stageField, projectsPat, issueOwner, issueRepo, issueNum },
  io = defaultIo,
) {
  if (plan.action === 'field_from_board') {
    const canonicalField = resolveCanonicalOption(plan.newF, stageField.options);
    if (!canonicalField) {
      throw new Error(`Cannot map board status to Stage field: ${plan.newF}`);
    }
    await io.setIssueStageField({
      owner: issueOwner,
      repo: issueRepo,
      issueNumber: issueNum,
      token: projectsPat,
      stageFieldId: stageField.id,
      value: canonicalField,
    });
  } else if (plan.action === 'board_from_field') {
    const canonicalBoard = resolveCanonicalOption(plan.newP, board.columns);
    if (!canonicalBoard) {
      throw new Error(`Cannot map Stage field to board column: ${plan.newP}`);
    }
    const fullIssue = await io.fetchIssue(issueOwner, issueRepo, issueNum, projectsPat);
    await io.updateProjectStatus({
      issue: fullIssue,
      projectId: board.projectId,
      statusFieldId: board.statusFieldId,
      statusName: canonicalBoard,
      projectsPat,
    });
  }

  if (plan.newS != null) {
    await io.updateProjectItemTextField({
      projectId: board.projectId,
      itemId: row.projectItemId,
      fieldId: board.syncedFieldId,
      text: plan.newS,
      projectsPat,
    });
  }
}

/**
 * Run `handle` for every row. A row that throws is recorded and the loop moves on, so one bad item
 * cannot stop the rest of the board. The caller decides whether the run fails.
 */
async function forEachRowIsolated(rows, handle) {
  const failures = [];
  for (const row of rows) {
    try {
      await handle(row);
    } catch (err) {
      failures.push({ ref: rowRef(row), message: err && err.message ? err.message : String(err) });
    }
  }
  return failures;
}

async function reconcileBoard({
  board,
  stageField,
  projectsPat,
  dryRun,
  issueFilter,
  io = defaultIo,
  ports = {},
}) {
  const assertSyncedField = ports.assertSyncedField || assertProjectTextField;
  const listIssues = ports.listIssues || listProjectIssues;
  const readStage = ports.readStage || null;
  const loadMirrorIssue = ports.fetchIssueForMirror || fetchIssueForMirror;
  await assertSyncedField(projectsPat, board.syncedFieldId, 'Synced stage');
  assertBoardColumnsMatchStageOptions(
    board.columns,
    stageField.options,
    board.label,
    stageField.name,
  );

  const rows = await listIssues({
    projectId: board.projectId,
    statusFieldId: board.statusFieldId,
    syncedFieldId: board.syncedFieldId,
    projectsPat,
  });

  const stats = { scanned: 0, planned: 0, applied: 0, noop: 0, failures: [] };

  stats.failures = await forEachRowIsolated(rows, async (row) => {
    const issueNum = row.issue.number;
    if (issueFilter != null && Number(issueFilter) !== Number(issueNum)) {
      return;
    }
    const issueOwner = row.issue.repository?.owner?.login || board.owner;
    const issueRepo = row.issue.repository?.name || board.repo;

    // The v2 engine owns Stage for its issues; mirroring Status over it would undo its decisions.
    // Only the Pawpet board's issues in the engine's repository: ATSupport and others stay mirrored.
    const ownedByV2 =
      inEngineScope({
        boardKey: board.key,
        issueRepoSlug: `${issueOwner}/${issueRepo}`,
        defaultRepoSlug: `${board.owner}/${board.repo}`,
      }) &&
      (await v2OwnsLazy({
        getLabels: async () =>
          labelNames(await fetchIssue(issueOwner, issueRepo, issueNum, projectsPat)),
      }));
    if (ownedByV2) {
      stats.noop += 1;
      return;
    }

    const mirrorIssue = await loadMirrorIssue(
      issueOwner,
      issueRepo,
      issueNum,
      projectsPat,
      stageField.id,
    );
    if (board.supportIssueTypes?.length) {
      const typeName = mirrorIssue.typeName;
      if (!board.supportIssueTypes.includes(typeName)) {
        stats.noop += 1;
        return;
      }
    }

    stats.scanned += 1;
    const P = row.status || '';
    const S = row.syncedStage || '';
    const F = readStage
      ? (await readStage(issueOwner, issueRepo, issueNum, projectsPat, stageField.id)) || ''
      : mirrorIssue.stage || '';

    const plan = decideStageMirror(P, F, S, board.columns);
    if (plan.action === 'none') {
      stats.noop += 1;
      return;
    }

    logMirrorLine(board.key, row, P, F, S, plan, dryRun);
    stats.planned += 1;
    if (dryRun) {
      return;
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
    }, io);
    stats.applied += 1;
  });

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

  // Config problems stop the run before any write.
  for (const board of config.boards) {
    await assertStageFieldOptions(
      projectsPat,
      board.statusFieldId,
      board.columns,
      board.label,
    );
  }

  const issueFilter = process.env.ISSUE_NUMBER ? Number(process.env.ISSUE_NUMBER) : null;
  const totals = { scanned: 0, planned: 0, applied: 0, noop: 0 };
  const failures = [];

  for (const board of config.boards) {
    let stats;
    try {
      const stageField = await loadBoardMirrorField(board, {
        org: config.org,
        token: projectsPat,
      });
      stats = await reconcileBoard({
        board,
        stageField,
        projectsPat,
        dryRun,
        issueFilter,
      });
    } catch (err) {
      // A board-level failure must not stop the other board.
      failures.push({ ref: board.label, message: err.message });
      continue;
    }
    totals.scanned += stats.scanned;
    totals.planned += stats.planned;
    totals.applied += stats.applied;
    totals.noop += stats.noop;
    failures.push(...stats.failures);
  }

  for (const failure of failures) {
    console.error(`[error] ${failure.ref}: ${failure.message}`);
  }
  console.log(
    `stage-mirror complete mode=${mode} dry_run=${dryRun} scanned=${totals.scanned} planned=${totals.planned} applied=${totals.applied} noop=${totals.noop} failures=${failures.length}`,
  );
  if (failures.length > 0) {
    // Fail the run so the problem is visible, after every other item has been mirrored.
    throw new Error(`stage-mirror: ${failures.length} failure(s); other items were still mirrored`);
  }
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
  forEachRowIsolated,
  runStageMirror,
};
