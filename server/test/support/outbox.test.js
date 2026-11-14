import { v4 as uuidv4 } from 'uuid';

import { buildSupportReceiptEmail } from '../../lib/support/outbox/receiptEmail.js';
import {
  buildGithubIssueBody,
  buildGithubIssueClassification,
  buildGithubIssueTitle,
} from '../../lib/support/outbox/issueContent.js';
import {
  refreshSupportIssueCatalogGate,
  resetSupportIssueFieldCatalogForTests,
} from '../../lib/support/outbox/issueFieldCatalog.js';
import {
  refreshSupportGithubRepoGate,
  resetSupportGithubRepoGateCacheForTests,
} from '../../lib/support/outbox/repoGate.js';
import { writeGithubIssueNumber } from '../../lib/support/outbox/rowState.js';
import { createGithubSupportIssue, fetchGithubRepoPrivacy } from '../../lib/support/outbox/githubApi.js';
import { processSupportOutboxRow } from '../../lib/support/outbox/processRow.js';

jest.mock('../../lib/support/outbox/githubApi.js', () => ({
  ...jest.requireActual('../../lib/support/outbox/githubApi.js'),
  fetchGithubRepoPrivacy: jest.fn(),
}));

describe('support receipt email', () => {
  it('builds EN and FR subjects with reference', () => {
    const ref = 'AT-ABCDEFGH';
    const en = buildSupportReceiptEmail({ locale: 'en', reference: ref });
    const fr = buildSupportReceiptEmail({ locale: 'fr', reference: ref });

    expect(en.subject).toBe(`[${ref}] We received your request`);
    expect(fr.subject).toBe(`[${ref}] Nous avons reçu votre demande`);
    expect(en.text).toContain(ref);
    expect(en.text).not.toContain('user wrote');
    expect(fr.text).toContain(ref);
  });
});

describe('github issue content', () => {
  const ticket = {
    reference: 'AT-ZZZZZZZZ',
    category: 'bug',
    title: 'Crash on save',
    description: 'It breaks',
    expected: 'Save works',
    actual: 'Error',
    steps: '1. Tap save',
    frequency: 'always',
    context: { version: '1.0', platform: 'web' },
  };

  it('classifies a bug without Support Category', () => {
    process.env.APP_ENV = 'uat';
    expect(buildGithubIssueTitle(ticket)).toBe('[AT-ZZZZZZZZ] bug: Crash on save');
    expect(buildGithubIssueClassification(ticket)).toEqual({
      type: 'Support Bug',
      fields: [
        { name: 'Environment', value: 'UAT' },
        { name: 'Source', value: 'form' },
        { name: 'Website or App', value: 'Website' },
      ],
    });
    process.env.APP_ENV = 'production';
    expect(buildGithubIssueClassification(ticket).fields).toEqual(
      expect.arrayContaining([{ name: 'Environment', value: 'Prod' }]),
    );
    delete process.env.APP_ENV;
    const omitted = buildGithubIssueClassification(ticket).fields.map((field) => field.name);
    expect(omitted).not.toContain('Environment');
    expect(omitted).not.toContain('Support Category');
  });

  it.each([
    ['suggestion', 'Suggestion'],
    ['account', 'Account'],
    ['billing', 'Billing'],
  ])('classifies %s as Support Question', (category, supportCategory) => {
    delete process.env.APP_ENV;
    expect(buildGithubIssueClassification({ ...ticket, category })).toEqual({
      type: 'Support Question',
      fields: [
        { name: 'Support Category', value: supportCategory },
        { name: 'Source', value: 'form' },
        { name: 'Website or App', value: 'Website' },
      ],
    });
  });

  it('rejects an unknown category', () => {
    expect(buildGithubIssueClassification({ ...ticket, category: 'other' })).toBeNull();
  });

  it('fences reporter content and lists allowlisted context', () => {
    const body = buildGithubIssueBody(ticket);
    expect(body).toContain('Reporter submission (untrusted)');
    expect(body).toContain('```');
    expect(body).toContain('It breaks');
    expect(body).toContain('version: 1.0');
    expect(body).not.toContain('reporter_email');
  });
});

describe('github repo gate', () => {
  const mockQuery = jest.fn();
  const pool = { query: mockQuery };

  beforeEach(() => {
    mockQuery.mockReset();
    fetchGithubRepoPrivacy.mockReset();
    resetSupportGithubRepoGateCacheForTests();
    delete process.env.SUPPORT_GITHUB_REPO;
  });

  it('blocks create-issue rows when repo is public', async () => {
    process.env.SUPPORT_GITHUB_REPO = 'AgathaTrack/AgathaTrack';
    fetchGithubRepoPrivacy.mockResolvedValue({ ok: false, reason: 'repo is not private' });
    mockQuery.mockResolvedValue({ rowCount: 2 });

    await refreshSupportGithubRepoGate(pool);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining(`status = 'blocked'`),
      ['repo is not private'],
    );
  });

  it('returns blocked rows to pending when repo is private', async () => {
    process.env.SUPPORT_GITHUB_REPO = 'owner/AgathaTrackPrivate';
    fetchGithubRepoPrivacy.mockResolvedValue({ ok: true, private: true });
    mockQuery.mockResolvedValue({ rowCount: 1 });

    await refreshSupportGithubRepoGate(pool);

    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining(`status = 'pending'`));
  });
});

describe('writeGithubIssueNumber', () => {
  it('queues redact when ticket is gone', async () => {
    const client = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rowCount: 0 })
        .mockResolvedValueOnce({ rowCount: 1 }),
    };
    const ticketId = uuidv4();
    const exists = await writeGithubIssueNumber(client, ticketId, 42);
    expect(exists).toBe(false);
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[1][0]).toContain('github_issue_delete');
  });
});

const CATALOG_TYPES = [
  { name: 'Support Bug', is_enabled: true },
  { name: 'Support Question', is_enabled: true },
  { name: 'Bug', is_enabled: true },
];

const CATALOG_FIELDS = [
  { id: 11, name: 'Support Category', options: [{ name: 'Suggestion' }, { name: 'Account' }, { name: 'Billing' }, { name: 'Other' }] },
  { id: 12, name: 'Environment', options: [{ name: 'UAT' }, { name: 'Prod' }] },
  { id: 13, name: 'Source', options: [{ name: 'form' }, { name: 'email' }, { name: 'other' }] },
  { id: 14, name: 'Website or App', options: [{ name: 'Website' }, { name: 'App' }] },
];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function catalogFetch(extra) {
  return jest.fn(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/issue-types')) return jsonResponse(200, CATALOG_TYPES);
    if (path.endsWith('/issue-fields')) return jsonResponse(200, CATALOG_FIELDS);
    return extra(path, init);
  });
}

describe('github issue classification create', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    resetSupportIssueFieldCatalogForTests();
    process.env.SUPPORT_GITHUB_REPO = 'AgathaTrack/AgathaTrackPrivate';
    process.env.SUPPORT_GITHUB_TOKEN = 'test-token';
    process.env.APP_ENV = 'uat';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.SUPPORT_GITHUB_REPO;
    delete process.env.SUPPORT_GITHUB_TOKEN;
    delete process.env.APP_ENV;
  });

  it('creates a Support Bug with field ids and no labels', async () => {
    global.fetch = catalogFetch(async () => jsonResponse(201, {
      number: 15,
      type: { name: 'Support Bug' },
      issue_field_values: [
        { field_id: 12, value: 'UAT' },
        { field_id: 13, value: 'form' },
        { field_id: 14, value: 'Website' },
      ],
    }));

    const classification = buildGithubIssueClassification({
      category: 'bug',
      reference: 'AT-ZZZZZZZZ',
      title: 'Crash',
    });
    const outcome = await createGithubSupportIssue({
      title: '[AT-ZZZZZZZZ] bug: Crash',
      body: 'body',
      classification,
    });

    expect(outcome).toEqual({ ok: true, number: 15 });
    const post = global.fetch.mock.calls.find((call) => call[1]?.method === 'POST');
    const payload = JSON.parse(post[1].body);
    expect(payload.type).toBe('Support Bug');
    expect(payload.labels).toBeUndefined();
    expect(payload.issue_field_values).toEqual([
      { field_id: 12, value: 'UAT' },
      { field_id: 13, value: 'form' },
      { field_id: 14, value: 'Website' },
    ]);
    expect(post[1].headers['X-GitHub-Api-Version']).toBe('2026-03-10');
    expect(global.fetch.mock.calls.some((call) => String(call[0]).endsWith('/issues/15'))).toBe(false);
  });

  it('stores the issue number and does not retry when classification is missing', async () => {
    global.fetch = catalogFetch(async (path, init) => {
      if (init?.method === 'POST') {
        return jsonResponse(201, { number: 21, type: null, issue_field_values: [] });
      }
      if (String(path).endsWith('/issues/21')) {
        return jsonResponse(200, { number: 21, type: { name: 'Task' }, issue_field_values: [] });
      }
      return jsonResponse(500, {});
    });

    const ticketId = uuidv4();
    const rowId = uuidv4();
    const clientQuery = jest.fn(async (sql) => {
      if (sql === 'COMMIT') return { command: 'COMMIT' };
      if (String(sql).includes('UPDATE support_tickets')) return { rowCount: 1 };
      return { rowCount: 1 };
    });
    const pool = {
      query: jest.fn(async (sql) => {
        if (String(sql).includes('FROM support_tickets')) {
          return {
            rows: [{
              id: ticketId,
              reference: 'AT-ZZZZZZZZ',
              category: 'suggestion',
              title: 'Idea',
              description: 'please',
              context: {},
              locale: 'en',
            }],
          };
        }
        return { rowCount: 1 };
      }),
      connect: jest.fn(async () => ({ query: clientQuery, release: jest.fn() })),
    };

    await processSupportOutboxRow(pool, {
      id: rowId,
      ticket_id: ticketId,
      kind: 'github_issue',
      status: 'pending',
      attempts: 0,
    });

    const ticketUpdate = clientQuery.mock.calls.find((call) => String(call[0]).includes('github_issue_number'));
    expect(ticketUpdate[1]).toEqual([21, ticketId]);
    const failed = pool.query.mock.calls.find((call) => String(call[0]).includes(`status = 'failed'`));
    expect(failed[1][0]).toBe(rowId);
    expect(failed[1][1]).toBe(1);
    expect(failed[1][2].toISOString()).toBe('2099-01-01T00:00:00.000Z');
    expect(failed[1][3]).toBe('github issue missing classification');
    expect(global.fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
    const payload = JSON.parse(global.fetch.mock.calls.find((call) => call[1]?.method === 'POST')[1].body);
    expect(payload.type).toBe('Support Question');
    expect(payload.issue_field_values).toEqual(expect.arrayContaining([
      { field_id: 11, value: 'Suggestion' },
    ]));
  });

  it('blocks the row when the org catalog is missing', async () => {
    global.fetch = jest.fn(async () => jsonResponse(404, { message: 'Not Found' }));
    const ticketId = uuidv4();
    const rowId = uuidv4();
    const pool = {
      query: jest.fn(async (sql) => {
        if (String(sql).includes('FROM support_tickets')) {
          return {
            rows: [{
              id: ticketId,
              reference: 'AT-ZZZZZZZZ',
              category: 'bug',
              title: 'Crash',
              description: 'x',
              context: {},
              locale: 'en',
            }],
          };
        }
        return { rowCount: 1 };
      }),
      connect: jest.fn(),
    };

    await processSupportOutboxRow(pool, {
      id: rowId,
      ticket_id: ticketId,
      kind: 'github_issue',
      status: 'pending',
      attempts: 0,
    });

    expect(pool.connect).not.toHaveBeenCalled();
    const blocked = pool.query.mock.calls.find((call) => String(call[0]).includes(`status = 'blocked'`));
    expect(blocked[1]).toEqual([rowId, 'issue types HTTP 404']);
  });

  it('does not create a second issue when the ticket already has a number', async () => {
    global.fetch = jest.fn();
    const ticketId = uuidv4();
    const rowId = uuidv4();
    const pool = {
      query: jest.fn(async (sql) => {
        if (String(sql).includes('FROM support_tickets')) {
          return {
            rows: [{
              id: ticketId,
              reference: 'AT-ZZZZZZZZ',
              category: 'bug',
              title: 'Crash',
              github_issue_number: 21,
              context: {},
              locale: 'en',
            }],
          };
        }
        return { rowCount: 1 };
      }),
    };

    await processSupportOutboxRow(pool, {
      id: rowId,
      ticket_id: ticketId,
      kind: 'github_issue',
      status: 'pending',
      attempts: 1,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    const failed = pool.query.mock.calls.find((call) => String(call[0]).includes(`status = 'failed'`));
    expect(failed[1][3]).toBe('github issue already recorded');
    expect(failed[1][2].toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });
});

describe('github issue catalog gate', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    resetSupportIssueFieldCatalogForTests();
    process.env.SUPPORT_GITHUB_REPO = 'AgathaTrack/AgathaTrackPrivate';
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.SUPPORT_GITHUB_REPO;
  });

  it('blocks due rows when a required field is missing', async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/issue-types')) return jsonResponse(200, CATALOG_TYPES);
      return jsonResponse(200, CATALOG_FIELDS.filter((field) => field.name !== 'Source'));
    });
    const pool = { query: jest.fn(async () => ({ rowCount: 1 })) };

    await refreshSupportIssueCatalogGate(pool);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining(`status = 'blocked'`),
      ['issue field missing: Source'],
    );
    expect(pool.query.mock.calls[0][0]).toContain('next_attempt_at <= now()');
  });
});
