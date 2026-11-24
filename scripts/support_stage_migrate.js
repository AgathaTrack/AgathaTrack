'use strict';

/**
 * One-off: copy legacy org `Stage` values on support issues into `Support Stage`, then clear `Stage`.
 * Default is dry-run; set SUPPORT_STAGE_MIGRATE=apply to write.
 *
 * Requires the same secrets as stage-mirror plus STAGE_ISSUE_FIELD_ID and SUPPORT_STAGE_ISSUE_FIELD_ID.
 */

const { listProjectIssues } = require('../.github/scripts/github-project-lib');
const { loadStageMirrorBoards, SUPPORT_MIRROR_ISSUE_TYPES } = require('./stage_mirror_config');
const {
  loadOrgStageField,
  loadOrgSupportStageField,
  findFieldValueById,
  resolveCanonicalOption,
  buildCarriedIssueFieldPatch,
} = require('./stage_mirror_fields');
const { rest } = require('../.github/scripts/github-project-lib');

async function fetchIssueRaw(owner, repo, issueNumber, token) {
  return rest(
    'GET',
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
  );
}

async function applySupportStageMigrate({
  issue,
  issueOwner,
  issueRepo,
  num,
  projectsPat,
  legacyStage,
  supportStage,
  targetSupport,
}) {
  const payload = buildCarriedIssueFieldPatch(issue.issue_field_values, {
    set: [{ field_id: supportStage.id, value: targetSupport }],
    omitFieldIds: [legacyStage.id],
  });
  await rest(
    'PATCH',
    `/repos/${encodeURIComponent(issueOwner)}/${encodeURIComponent(issueRepo)}/issues/${num}`,
    projectsPat,
    { issue_field_values: payload },
  );
}

async function main() {
  const apply = String(process.env.SUPPORT_STAGE_MIGRATE || '').trim().toLowerCase() === 'apply';
  const repository = process.env.GITHUB_REPOSITORY || 'AgathaTrack/AgathaTrack';
  const [owner, repo] = repository.split('/');
  const config = loadStageMirrorBoards({ defaultOwner: owner, defaultRepo: repo });
  if (!config.ok) {
    throw new Error(config.reason);
  }
  const board = config.boards.find((entry) => entry.key === 'atsupport');
  if (!board) {
    throw new Error('ATSupport board config missing');
  }
  const projectsPat = process.env.GH_PROJECTS_PAT;
  const legacyStage = await loadOrgStageField({ org: config.org, token: projectsPat });
  const supportStage = await loadOrgSupportStageField({ org: config.org, token: projectsPat });

  const rows = await listProjectIssues({
    projectId: board.projectId,
    statusFieldId: board.statusFieldId,
    projectsPat,
    includeClosed: true,
  });

  let migrated = 0;
  let skipped = 0;
  for (const row of rows) {
    const issueOwner = row.issue.repository?.owner?.login || board.owner;
    const issueRepo = row.issue.repository?.name || board.repo;
    const num = row.issue.number;
    const issue = await fetchIssueRaw(issueOwner, issueRepo, num, projectsPat);
    const typeName = issue?.type?.name || '';
    if (!SUPPORT_MIRROR_ISSUE_TYPES.includes(typeName)) {
      skipped += 1;
      continue;
    }
    const fromStage =
      findFieldValueById(issue?.issue_field_values, legacyStage.id) || '';
    const fromSupport =
      findFieldValueById(issue?.issue_field_values, supportStage.id) || '';
    const legacyCanonical = resolveCanonicalOption(fromStage, supportStage.options);
    const supportCanonical = resolveCanonicalOption(fromSupport, supportStage.options);

    if (!legacyCanonical) {
      if (fromStage) {
        console.log(
          `[skip] ${issueRepo}#${num} Stage=${JSON.stringify(fromStage)} not a support column`,
        );
      }
      skipped += 1;
      continue;
    }

    if (supportCanonical && !fromStage) {
      skipped += 1;
      continue;
    }

    const targetSupport = supportCanonical || legacyCanonical;
    const action =
      supportCanonical && fromStage
        ? 'clear legacy Stage'
        : `Stage → Support Stage ${targetSupport}`;
    console.log(`${apply ? '[apply]' : '[dry-run]'} ${issueRepo}#${num} ${action}`);
    if (apply) {
      await applySupportStageMigrate({
        issue,
        issueOwner,
        issueRepo,
        num,
        projectsPat,
        legacyStage,
        supportStage,
        targetSupport,
      });
    }
    migrated += 1;
  }
  console.log(`support_stage_migrate complete apply=${apply} migrated=${migrated} skipped=${skipped}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main, applySupportStageMigrate };