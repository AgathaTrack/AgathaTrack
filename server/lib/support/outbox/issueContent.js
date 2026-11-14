import { getSupportEnvironmentValue } from './config.js';

const CONTEXT_KEYS = [
  'version',
  'build',
  'platform',
  'browser_family',
  'locale',
  'route_name',
  'client_time',
];

const ISSUE_TYPE_BY_CATEGORY = {
  bug: 'Support Bug',
  suggestion: 'Support Question',
  account: 'Support Question',
  billing: 'Support Question',
};

const SUPPORT_CATEGORY_BY_CATEGORY = {
  suggestion: 'Suggestion',
  account: 'Account',
  billing: 'Billing',
};

function formatContextBlock(context) {
  const lines = [];
  const data = context && typeof context === 'object' ? context : {};
  for (const key of CONTEXT_KEYS) {
    if (data[key] !== undefined && data[key] !== '') {
      lines.push(`- ${key}: ${String(data[key])}`);
    }
  }
  if (lines.length === 0) {
    return '_No technical context submitted._';
  }
  return lines.join('\n');
}

function reporterBlock(ticket) {
  const parts = [
    `**Category:** ${ticket.category}`,
    '',
    ticket.description || '',
  ];
  if (ticket.category === 'bug') {
    if (ticket.expected) parts.push('', `**Expected:** ${ticket.expected}`);
    if (ticket.actual) parts.push('', `**Actual:** ${ticket.actual}`);
    if (ticket.steps) parts.push('', `**Steps:**\n${ticket.steps}`);
    if (ticket.frequency) parts.push('', `**Frequency:** ${ticket.frequency}`);
  }
  return parts.join('\n');
}

export function buildGithubIssueTitle(ticket) {
  return `[${ticket.reference}] ${ticket.category}: ${ticket.title}`;
}

export function buildGithubIssueBody(ticket) {
  const untrusted = reporterBlock(ticket);
  const context = formatContextBlock(ticket.context);
  return [
    '> **Reporter submission (untrusted)**',
    '>',
    '```',
    untrusted,
    '```',
    '',
    '## Technical context (allowlisted)',
    '',
    context,
    '',
    `Support reference: \`${ticket.reference}\``,
  ].join('\n');
}

/**
 * Issue type and org issue fields for a form submit.
 * Bug leaves Support Category empty. Other form categories set it.
 * @returns {{ type: string, fields: { name: string, value: string }[] } | null}
 */
export function buildGithubIssueClassification(ticket) {
  const type = ISSUE_TYPE_BY_CATEGORY[ticket.category];
  if (!type) return null;
  const fields = [];
  const supportCategory = SUPPORT_CATEGORY_BY_CATEGORY[ticket.category];
  if (supportCategory) {
    fields.push({ name: 'Support Category', value: supportCategory });
  }
  const environment = getSupportEnvironmentValue();
  if (environment) {
    fields.push({ name: 'Environment', value: environment });
  }
  fields.push({ name: 'Source', value: 'form' });
  fields.push({ name: 'Website or App', value: 'Website' });
  return { type, fields };
}
