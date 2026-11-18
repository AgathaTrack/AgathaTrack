'use strict';

/**
 * Pipeline v2 intent review (#2385 run B, P6). When an issue's work is merged, one agent that did
 * not write the PRs reviews what shipped against the issue's original intent and files each finding
 * as a new issue. The engine only asks (a marker comment plus the doorbell) and reads the follow-ups'
 * depth back; the review itself is the agent's work (`.cursor/skills/intent-review-agent`).
 *
 * A follow-up issue carries `<!-- v2:follow-up of=#<parent> -->` in its body. Its depth is the length
 * of that chain, counted by the engine from the parents' own bodies, never from a number an agent wrote.
 */

const { INTENT_REVIEW } = require('./issue_pipeline_v2_release');
const { resolveAgent } = require('./issue_pipeline_v2_config');

const FOLLOW_UP = /<!--\s*v2:follow-up\s+of=#(\d+)\s*-->/i;

/** The request comment. The marker is what `deriveDeliveryFacts` reads back as `requested`. */
function buildIntentReviewRequest({ agent, issueNumber, prNumbers = [], mergeSha, config }) {
  const entry = config ? resolveAgent(config, agent) : null;
  const id = entry?.id || agent;
  const mention = entry?.actsAs || agent;
  const merged = prNumbers.length > 0 ? prNumbers.map((n) => `#${n}`).join(', ') : 'the merged change';
  return [
    `<!-- ${INTENT_REVIEW} agent=${id} merge=${mergeSha} -->`,
    `@${mention}: intent review of #${issueNumber}. Review what shipped in ${merged} against the issue's original intent (its summary, problem and Definition of Done), not against the diff alone.`,
    '',
    `File each real finding as a new issue that starts with \`<!-- v2:follow-up of=#${issueNumber} -->\`, and say here which ones you filed. Leave their \`Stage\` empty; the engine puts them in To do. Nothing to file is a valid result: say so once.`,
  ].join('\n');
}

/** Parent issue number from a follow-up's body, or null. */
function parseFollowUp(body) {
  const match = FOLLOW_UP.exec(String(body || ''));
  return match ? Number(match[1]) : null;
}

/**
 * Depth of a follow-up chain: 0 for an ordinary issue, 1 for a follow-up of one, and so on. Stops
 * counting after `maxHops` so a cycle or a very long chain cannot cost unbounded calls.
 * @param {(number: number) => Promise<{body?: string}>} getIssue
 */
async function followUpDepth({ body, getIssue, maxHops = 4 }) {
  let depth = 0;
  let parent = parseFollowUp(body);
  const seen = new Set();
  while (parent && depth < maxHops && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    const issue = await getIssue(parent);
    parent = parseFollowUp(issue?.body);
  }
  return depth;
}

module.exports = { FOLLOW_UP, buildIntentReviewRequest, parseFollowUp, followUpDepth };
