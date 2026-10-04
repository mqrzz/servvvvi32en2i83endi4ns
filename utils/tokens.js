const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SESSION_DAYS = 30;

function signServiceToken(userId) {
  return jwt.sign({ uid: userId, purpose: 'payment-service' }, process.env.JWT_SECRET, { expiresIn: '5m' });
}
function verifyServiceToken(token) {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return payload.purpose === 'payment-service' ? payload : null;
  } catch (e) {
    return null;
  }
}

function signSessionToken(userId, sessionId) {
  return jwt.sign({ uid: userId, sid: sessionId }, process.env.JWT_SECRET, {
    expiresIn: `${SESSION_DAYS}d`,
  });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d;
}

module.exports = { signSessionToken, verifySessionToken, hashToken, sessionExpiryDate, SESSION_DAYS, signServiceToken, verifyServiceToken };
