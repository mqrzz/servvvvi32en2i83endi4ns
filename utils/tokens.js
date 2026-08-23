const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SESSION_DAYS = 30;

// Короткоживущий токен для доверенных серверных вызовов (например, Vercel
// payment-функций от лица залогиненного юзера) — НЕ хранится в БД как
// сессия, просто короткое (5 мин) доказательство личности для одного запроса.
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

module.exports = { signSessionToken, verifySessionToken, hashToken, sessionExpiryDate, SESSION_DAYS, signServiceToken, verifyServiceToken };
