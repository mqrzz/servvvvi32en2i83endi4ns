const crypto = require('crypto');

function generateCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function verifyCode(code, hash) {
  return hashCode(code) === hash;
}

module.exports = { generateCode, hashCode, verifyCode };
