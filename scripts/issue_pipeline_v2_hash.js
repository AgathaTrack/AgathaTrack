'use strict';

const crypto = require('crypto');

function normalizeBodyForHash(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text.replace(/[ \t]+$/gm, '').trimEnd();
}

function bodySha(body) {
  const normalized = normalizeBodyForHash(body);
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

module.exports = { normalizeBodyForHash, bodySha };