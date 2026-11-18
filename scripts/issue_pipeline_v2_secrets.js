'use strict';

const crypto = require('crypto');

/** Per-run secret passed only in the agent environment (never stored). */
function deriveRunSecret(voteKey, issueNumber, agentId, stage, nonceHex) {
  const key = Buffer.from(String(voteKey || ''), 'utf8');
  const material = [String(issueNumber), String(agentId), String(stage), String(nonceHex)].join('|');
  return crypto.createHmac('sha256', key).update(material, 'utf8').digest('hex');
}

function randomNonceHex() {
  return crypto.randomBytes(16).toString('hex');
}

function verdictSignature(runSecret, issueNumber, agentId, nonceHex, kind, hash, value) {
  const material = [String(issueNumber), String(agentId), String(nonceHex), kind, hash, value].join('|');
  return crypto.createHmac('sha256', Buffer.from(runSecret, 'hex')).update(material, 'utf8').digest('hex');
}

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(String(a || ''), 'hex');
    const right = Buffer.from(String(b || ''), 'hex');
    if (left.length !== right.length) {
      return false;
    }
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

module.exports = { deriveRunSecret, randomNonceHex, verdictSignature, timingSafeEqualHex };