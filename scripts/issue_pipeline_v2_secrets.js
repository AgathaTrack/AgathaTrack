'use strict';

const crypto = require('crypto');

function randomNonceHex() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = { randomNonceHex };