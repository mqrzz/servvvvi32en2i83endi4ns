const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SESSION_DAYS = 30;

// Сам токен, который уходит юзеру в cookie
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

// В БД храним не сам токен, а его хэш — на случай утечки БД токены нельзя будет переиспользовать напрямую
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionExpiryDate() {
  const d = new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d;
}

module.exports = { signSessionToken, verifySessionToken, hashToken, sessionExpiryDate, SESSION_DAYS };
