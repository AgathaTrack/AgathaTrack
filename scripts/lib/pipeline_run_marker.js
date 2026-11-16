'use strict';

const { parseRunMarker } = require('../../.github/scripts/agent-payload-lib');

/**
 * Identities that write `cursor-agent-run` markers: the pipeline implement launch (bot token)
 * and the legacy agent-dispatch workflow (Actions token). Anyone else's marker is ignored.
 */
const TRUSTED_RUN_MARKER_AUTHORS = new Set(['pawpet-bot', 'pawpet-claude', 'github-actions[bot]']);
const ACTIVE_RUN_STATUSES = new Set(['running', 'dispatched', 'creating']);

/**
 * Newest run marker (by update time) from a trusted author.
 * @returns {{ comment: object, marker: object } | null}
 */
function findTrustedRunMarker(comments) {
  let latest = null;
  for (const comment of comments || []) {
    const author = comment?.user?.login;
    if (!author || !TRUSTED_RUN_MARKER_AUTHORS.has(author)) {
      continue;
    }
    const marker = parseRunMarker(comment.body);
    if (!marker) {
      continue;
    }
    const updatedAt = comment.updated_at || comment.created_at || '';
    if (!latest || updatedAt >= latest.updatedAt) {
      latest = { comment, marker, updatedAt };
    }
  }
  return latest ? { comment: latest.comment, marker: latest.marker } : null;
}

function isActiveRunMarker(marker) {
  return Boolean(marker && ACTIVE_RUN_STATUSES.has(marker.status));
}

function isStubRunMarker(marker) {
  return Boolean(
    marker &&
      (marker.stub || marker.agentId === 'pipeline-stub' || marker.runId === 'pipeline-stub'),
  );
}

module.exports = {
  TRUSTED_RUN_MARKER_AUTHORS,
  findTrustedRunMarker,
  isActiveRunMarker,
  isStubRunMarker,
};
