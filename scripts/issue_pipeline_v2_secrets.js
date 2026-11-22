'use strict';

const crypto = require('crypto');

function randomNonceHex() {
  return crypto.randomBytes(16).toString('hex');
}

/** The public promise for a nonce (PIPE-V2-D-REV3-011): published at launch, matched at reveal. */
function commitOf(nonce) {
  return crypto.createHash('sha256').update(String(nonce)).digest('hex');
}

module.exports = { randomNonceHex, commitOf };