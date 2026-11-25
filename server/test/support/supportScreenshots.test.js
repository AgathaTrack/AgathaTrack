import fs from 'fs';
import os from 'os';
import path from 'path';

import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from '@jest/globals';

import sharp from 'sharp';

import { createApp } from '../../bin/server.js';
import { createTransactionalMockPool } from '../helpers/transactionMockPool.js';

const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET || 'default_secret';
const userId = 'support-user-1';
const staffUserId = 'staff-user-1';
const token = jwt.sign({ id: userId, email: 'account@example.com', typ: 'access' }, JWT_SECRET, {
  expiresIn: '1h',
});
const staffToken = jwt.sign(
  { id: staffUserId, email: 'staff@example.com', typ: 'access' },
  JWT_SECRET,
  { expiresIn: '1h' },
);

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function validPayload() {
  return {
    category: 'suggestion',
    title: 'Screenshot test',
    description: 'Testing screenshots.',
    locale: 'en',
    context: { version: '1.0.0', platform: 'web' },
  };
}

function createSupportScreenshotMockPool() {
  const attachmentById = new Map();
  let lastAttachmentId = null;
  const pool = createTransactionalMockPool(async (sql, params) => {
    const text = String(sql);

    if (text.includes('SELECT is_support_staff FROM users WHERE id = $1')) {
      const id = params?.[0];
      return {
        rows: [{ is_support_staff: id === staffUserId }],
      };
    }
    if (text.includes('SELECT 1 FROM users WHERE id = $1')) {
      return { rows: [{ '?column?': 1 }] };
    }
    if (text.includes('SELECT email FROM users WHERE id = $1')) {
      return { rows: [{ email: 'account@example.com' }] };
    }
    if (text.includes('COUNT(*)::int AS c') && text.includes('support_tickets')) {
      return { rows: [{ c: 0, oldest: new Date() }] };
    }
    if (text.startsWith('INSERT INTO support_tickets')) {
      return { rowCount: 1 };
    }
    if (text.startsWith('INSERT INTO support_attachments')) {
      const id = params[0];
      attachmentById.set(id, {
        storage_key: params[2],
        mime: params[3],
      });
      lastAttachmentId = id;
      return { rowCount: 1 };
    }
    if (text.includes('FROM support_attachments') && text.includes('WHERE id = $1')) {
      const row = attachmentById.get(params[0]);
      return { rows: row ? [{ ...row, id: params[0] }] : [] };
    }
    if (text.startsWith('INSERT INTO support_outbox')) {
      return { rowCount: 2 };
    }
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [], command: text };
    }
    return { rows: [] };
  });
  return { pool, getLastAttachmentId: () => lastAttachmentId };
}

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.PRIVATE_SUPPORT_SCREENSHOT_DIR;
});

describe('support screenshots', () => {
  it('rejects signed-out multipart upload with screenshots', async () => {
    const { pool } = createSupportScreenshotMockPool();
    const app = createApp(pool);
    const res = await request(app)
      .post('/api/support/tickets')
      .field('category', 'bug')
      .field('title', 'Bug')
      .field('description', 'Desc')
      .field('locale', 'en')
      .field('email', 'guest@example.com')
      .attach('screenshots', PNG_1X1, { filename: 'shot.png', contentType: 'image/png' });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/signed-in/i);
  });

  it('returns 403 before lookup for non-staff attachment GET', async () => {
    const { pool } = createSupportScreenshotMockPool();
    const app = createApp(pool);
    const res = await request(app)
      .get('/api/support/attachments/00000000-0000-4000-8000-000000000099')
      .set('Authorization', `Bearer ${token}`);
    expect(res.statusCode).toBe(403);
  });

  it('stores screenshots for signed-in submit and allows staff GET', async () => {
    const screenshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'support-shots-'));
    tempDirs.push(screenshotRoot);
    process.env.PRIVATE_SUPPORT_SCREENSHOT_DIR = screenshotRoot;

    const { pool, getLastAttachmentId } = createSupportScreenshotMockPool();
    const app = createApp(pool);

    const submit = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(validPayload()))
      .attach('screenshots', PNG_1X1, { filename: 'shot.png', contentType: 'image/png' });
    expect(submit.statusCode).toBe(201);

    expect(fs.readdirSync(screenshotRoot).length).toBe(1);

    const attachmentId = getLastAttachmentId();
    expect(attachmentId).toBeTruthy();

    const denied = await request(app)
      .get(`/api/support/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(denied.statusCode).toBe(403);

    const staffRes = await request(app)
      .get(`/api/support/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffRes.statusCode).toBe(200);
    expect(staffRes.headers['content-type']).toMatch(/image\/png/);
    expect(staffRes.body.length).toBeGreaterThan(0);
  });

  it('returns 400 when re-encode rejects an oversized decoded image', async () => {
    const screenshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'support-shots-'));
    tempDirs.push(screenshotRoot);
    process.env.PRIVATE_SUPPORT_SCREENSHOT_DIR = screenshotRoot;

    const huge = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: '#224466' },
    })
      .png()
      .toBuffer();

    const { pool } = createSupportScreenshotMockPool();
    const app = createApp(pool);

    const submit = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(validPayload()))
      .attach('screenshots', huge, { filename: 'huge.png', contentType: 'image/png' });

    expect(submit.statusCode).toBe(400);
    expect(submit.body.error).toMatch(/Invalid screenshot image/i);
    expect(fs.readdirSync(screenshotRoot).length).toBe(0);
  });

  it('persists re-encoded bytes without EXIF metadata', async () => {
    const screenshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'support-shots-'));
    tempDirs.push(screenshotRoot);
    process.env.PRIVATE_SUPPORT_SCREENSHOT_DIR = screenshotRoot;

    const withExif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: {
            ImageDescription: 'support-intake-exif',
          },
        },
      })
      .toBuffer();

    const { pool, getLastAttachmentId } = createSupportScreenshotMockPool();
    const app = createApp(pool);

    const submit = await request(app)
      .post('/api/support/tickets')
      .set('Authorization', `Bearer ${token}`)
      .field('payload', JSON.stringify(validPayload()))
      .attach('screenshots', withExif, { filename: 'shot.jpg', contentType: 'image/jpeg' });
    expect(submit.statusCode).toBe(201);

    const attachmentId = getLastAttachmentId();
    const staffRes = await request(app)
      .get(`/api/support/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(staffRes.statusCode).toBe(200);

    const meta = await sharp(staffRes.body).metadata();
    expect(meta.exif).toBeFalsy();

    const files = fs.readdirSync(screenshotRoot);
    expect(files.length).toBe(1);
    const diskMeta = await sharp(path.join(screenshotRoot, files[0])).metadata();
    expect(diskMeta.exif).toBeFalsy();
  });
});
