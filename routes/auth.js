const express = require('express');
const UAParser = require('ua-parser-js');
const pool = require('../db/pool');
const { generateCode, hashCode, verifyCode } = require('../utils/codes');
const { sendCodeEmail, sendNewDeviceLoginEmail } = require('../utils/mailer');
const { signSessionToken, hashToken, sessionExpiryDate, SESSION_DAYS } = require('../utils/tokens');
const { sendCodeLimiter, verifyCodeLimiter } = require('../middleware/rateLimiters');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deviceNameFromUA(uaString) {
  const parser = new UAParser(uaString || '');
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const b = browser.name || 'Браузер';
  const o = os.name || '';
  return o ? `${b} на ${o}` : b;
}

// ── POST /api/auth/send-code ──
// body: { email, purpose: 'login' | 'register' }
router.post('/send-code', sendCodeLimiter, async (req, res) => {
  try {
    const { email, purpose = 'login' } = req.body;
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    if (!['login', 'register', 'delete_account'].includes(purpose)) {
      return res.status(400).json({ error: 'Некорректный purpose' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    const userExists = existing.rows.length > 0;

    // register должен требовать, чтобы юзера ещё не было; login/delete — чтобы был
    if (purpose === 'register' && userExists) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }
    if ((purpose === 'login' || purpose === 'delete_account') && !userExists) {
      return res.status(404).json({ error: 'Пользователь с таким email не найден' });
    }

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 минут

    await pool.query(
      `INSERT INTO auth_codes (email, code_hash, purpose, expires_at, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [normalizedEmail, codeHash, purpose, expiresAt, req.ip]
    );

    await sendCodeEmail(normalizedEmail, code, purpose);

    res.json({ ok: true, message: 'Код отправлен на почту' });
  } catch (err) {
    console.error('send-code error:', err);
    res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

// ── POST /api/auth/verify-code ──
// body: { email, code, purpose: 'login' | 'register', displayName? }
// Успешный вход/регистрация → ставит httpOnly cookie с session-токеном
router.post('/verify-code', verifyCodeLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, code, purpose = 'login', displayName } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email и код обязательны' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    await client.query('BEGIN');

    // Берём самый свежий неиспользованный код для этого email+purpose
    const { rows: codeRows } = await client.query(
      `SELECT * FROM auth_codes
       WHERE email = $1 AND purpose = $2 AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [normalizedEmail, purpose]
    );

    if (codeRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Код не найден, запросите новый' });
    }

    const authCode = codeRows[0];

    if (new Date(authCode.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Код истёк, запросите новый' });
    }

    if (authCode.attempts >= authCode.max_attempts) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Превышено число попыток, запросите новый код' });
    }

    if (!verifyCode(code.trim(), authCode.code_hash)) {
      await client.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [authCode.id]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Неверный код' });
    }

    // Код верный — помечаем использованным
    await client.query('UPDATE auth_codes SET used_at = now() WHERE id = $1', [authCode.id]);

    // Находим или создаём юзера
    let user;
    const { rows: existingUser } = await client.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);

    if (purpose === 'register') {
      if (existingUser.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Пользователь уже существует' });
      }
      const { rows: inserted } = await client.query(
        `INSERT INTO users (email, display_name) VALUES ($1, $2) RETURNING *`,
        [normalizedEmail, displayName?.trim() || 'Пользователь']
      );
      user = inserted[0];
    } else {
      if (existingUser.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Пользователь не найден' });
      }
      user = existingUser[0];
    }

    // Проверка на бан
    const { rows: banRows } = await client.query('SELECT * FROM bans WHERE user_id = $1', [user.id]);
    if (banRows.length > 0) {
      const ban = banRows[0];
      if (!ban.until || new Date(ban.until) > new Date()) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Аккаунт заблокирован', reason: ban.reason, until: ban.until });
      }
    }

    // Создаём сессию (устройство)
    const deviceName = deviceNameFromUA(req.headers['user-agent']);
    const expiresAt = sessionExpiryDate();

    const { rows: sessionRows } = await client.query(
      `INSERT INTO sessions (user_id, token_hash, device_name, user_agent, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [user.id, 'PENDING', deviceName, req.headers['user-agent'], req.ip, expiresAt]
    );
    const sessionId = sessionRows[0].id;

    const token = signSessionToken(user.id, sessionId);
    const tokenHash = hashToken(token);
    await client.query('UPDATE sessions SET token_hash = $1 WHERE id = $2', [tokenHash, sessionId]);

    await client.query('COMMIT');

    // Письмо о входе — только для 'login' (не для только что созданной регистрации,
    // это было бы избыточно). Не блокируем ответ пользователю ожиданием отправки.
    if (purpose === 'login') {
      sendNewDeviceLoginEmail(user.email, {
        deviceName,
        ipAddress: req.ip,
        time: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
      }).catch((e) => console.error('Не удалось отправить письмо о входе:', e));
    }

    res.cookie('session', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
      domain: '.antviz.ru',
    });

    res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        photoUrl: user.photo_url,
        role: user.role,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('verify-code error:', err);
    res.status(500).json({ error: 'Не удалось подтвердить код' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/logout ── разлогин текущего устройства
router.post('/logout', requireAuth, async (req, res) => {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.session_id]);
  res.clearCookie('session', { domain: '.antviz.ru' });
  res.json({ ok: true });
});

// ── GET /api/auth/me ── текущий юзер (для проверки "залогинен ли я" на фронте)
router.get('/me', requireAuth, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.display_name,
    photoUrl: req.user.photo_url,
    role: req.user.role,
  });
});

module.exports = router;
