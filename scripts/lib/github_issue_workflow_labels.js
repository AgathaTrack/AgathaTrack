'use strict';

/**
 * Issue label helpers for github_issue_workflow.js — REST only (no `gh issue edit` / GraphQL).
 */

async function ensureRepoLabels(client, specs) {
  const labels = [];
  for (const spec of specs) {
    await client.ensureLabel(spec.name, {
      color: spec.color,
      description: spec.description,
    });
    labels.push(spec.name);
  }
  return { ok: true, labels };
}

async function editIssueLabels(client, issueNumber, { add = [], remove = [] } = {}) {
  if (add.length === 0 && remove.length === 0) {
    return { skipped: true, reason: 'no_label_changes' };
  }
  if (add.length > 0) {
    await client.addLabels(issueNumber, add);
  }
  for (const label of remove) {
    await client.removeLabel(issueNumber, label);
  }
  return { ok: true, issueNumber, added: add, removed: remove };
}

module.exports = {
  editIssueLabels,
  ensureRepoLabels,
};