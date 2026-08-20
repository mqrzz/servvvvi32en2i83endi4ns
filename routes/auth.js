const express = require('express');
const bcrypt = require('bcryptjs');
const UAParser = require('ua-parser-js');
const pool = require('../db/pool');
const { generateCode, hashCode, verifyCode } = require('../utils/codes');
const { sendCodeEmail, sendNewDeviceLoginEmail } = require('../utils/mailer');
const { signSessionToken, hashToken, sessionExpiryDate, SESSION_DAYS } = require('../utils/tokens');
const { sendCodeLimiter, verifyCodeLimiter } = require('../middleware/rateLimiters');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;

function deviceNameFromUA(uaString) {
  const parser = new UAParser(uaString || '');
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const b = browser.name || 'Браузер';
  const o = os.name || '';
  return o ? `${b} на ${o}` : b;
}

async function createSession(client, userId, req) {
  const deviceName = deviceNameFromUA(req.headers['user-agent']);
  const expiresAt = sessionExpiryDate();
  const { rows } = await client.query(
    `INSERT INTO sessions (user_id, token_hash, device_name, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [userId, 'PENDING', deviceName, req.headers['user-agent'], req.ip, expiresAt]
  );
  const sessionId = rows[0].id;
  const token = signSessionToken(userId, sessionId);
  const tokenHash = hashToken(token);
  await client.query('UPDATE sessions SET token_hash = $1 WHERE id = $2', [tokenHash, sessionId]);
  return { token, deviceName };
}

function setSessionCookie(res, token) {
  res.cookie('session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    domain: '.antviz.ru',
  });
}

async function checkBan(client, userId) {
  const { rows } = await client.query('SELECT * FROM bans WHERE user_id = $1', [userId]);
  if (rows.length === 0) return null;
  const ban = rows[0];
  if (!ban.until || new Date(ban.until) > new Date()) return ban;
  return null;
}

// ── POST /api/auth/register ── создать аккаунт (email не подтверждён), отправить код
router.post('/register', sendCodeLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0 && existing.rows[0].email_verified) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    if (existing.rows.length > 0) {
      // Уже была попытка регистрации без подтверждения — обновляем данные и код
      await pool.query(
        'UPDATE users SET display_name = $1, password_hash = $2 WHERE id = $3',
        [name?.trim() || 'Пользователь', passwordHash, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO users (email, password_hash, display_name, email_verified) VALUES ($1, $2, $3, FALSE)`,
        [normalizedEmail, passwordHash, name?.trim() || 'Пользователь']
      );
    }

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO auth_codes (email, code_hash, purpose, expires_at, ip_address) VALUES ($1, $2, 'register', $3, $4)`,
      [normalizedEmail, codeHash, expiresAt, req.ip]
    );
    await sendCodeEmail(normalizedEmail, code, 'register');

    res.json({ ok: true, message: 'Код подтверждения отправлен на почту' });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Не удалось зарегистрироваться' });
  }
});

// ── POST /api/auth/register/verify ── подтвердить email кодом, войти
router.post('/register/verify', verifyCodeLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email и код обязательны' });
    const normalizedEmail = email.trim().toLowerCase();

    await client.query('BEGIN');

    const { rows: codeRows } = await client.query(
      `SELECT * FROM auth_codes WHERE email = $1 AND purpose = 'register' AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [normalizedEmail]
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
    await client.query('UPDATE auth_codes SET used_at = now() WHERE id = $1', [authCode.id]);

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (userRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const user = userRows[0];
    await client.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [user.id]);

    const { token } = await createSession(client, user.id, req);
    await client.query('COMMIT');

    setSessionCookie(res, token);
    res.json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name, photoUrl: user.photo_url, role: user.role },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('register/verify error:', err);
    res.status(500).json({ error: 'Не удалось подтвердить код' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/login ── вход по email+паролю
router.post('/login', verifyCodeLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email и пароль обязательны' });
    const normalizedEmail = email.trim().toLowerCase();

    const { rows } = await client.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const user = rows[0];

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Email не подтверждён. Проверьте почту или зарегистрируйтесь заново.' });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    await client.query('BEGIN');

    const ban = await checkBan(client, user.id);
    if (ban) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Аккаунт заблокирован', reason: ban.reason, until: ban.until });
    }

    const { token, deviceName } = await createSession(client, user.id, req);
    await client.query('COMMIT');

    setSessionCookie(res, token);

    sendNewDeviceLoginEmail(user.email, {
      deviceName,
      ipAddress: req.ip,
      time: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    }).catch((e) => console.error('Не удалось отправить письмо о входе:', e));

    res.json({
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.display_name, photoUrl: user.photo_url, role: user.role },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('login error:', err);
    res.status(500).json({ error: 'Не удалось войти' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/forgot-password ── отправить код для сброса пароля
router.post('/forgot-password', sendCodeLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Некорректный email' });
    const normalizedEmail = email.trim().toLowerCase();

    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1 AND email_verified = TRUE', [normalizedEmail]);
    // Намеренно не разглашаем, существует ли аккаунт — единый ответ в любом случае
    if (rows.length > 0) {
      const code = generateCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await pool.query(
        `INSERT INTO auth_codes (email, code_hash, purpose, expires_at, ip_address) VALUES ($1, $2, 'reset_password', $3, $4)`,
        [normalizedEmail, codeHash, expiresAt, req.ip]
      );
      await sendCodeEmail(normalizedEmail, code, 'reset_password');
    }

    res.json({ ok: true, message: 'Если такой аккаунт есть — код отправлен на почту' });
  } catch (err) {
    console.error('forgot-password error:', err);
    res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

// ── POST /api/auth/reset-password ── подтвердить код и задать новый пароль
router.post('/reset-password', verifyCodeLimiter, async (req, res) => {
  const client = await pool.connect();
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Заполните все поля' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Пароль должен быть не короче 6 символов' });
    const normalizedEmail = email.trim().toLowerCase();

    await client.query('BEGIN');

    const { rows: codeRows } = await client.query(
      `SELECT * FROM auth_codes WHERE email = $1 AND purpose = 'reset_password' AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [normalizedEmail]
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
    await client.query('UPDATE auth_codes SET used_at = now() WHERE id = $1', [authCode.id]);

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await client.query('UPDATE users SET password_hash = $1 WHERE email = $2', [passwordHash, normalizedEmail]);

    // Разлогиниваем все существующие сессии из соображений безопасности —
    // если пароль меняли не вы, старые сессии не должны остаться активными.
    const { rows: userRows } = await client.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (userRows.length > 0) {
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userRows[0].id]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, message: 'Пароль изменён, войдите заново' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('reset-password error:', err);
    res.status(500).json({ error: 'Не удалось сбросить пароль' });
  } finally {
    client.release();
  }
});

// ── Отправка кода для прочих целей (сейчас: удаление аккаунта) ──
router.post('/send-code', sendCodeLimiter, requireAuth, async (req, res) => {
  try {
    const { purpose } = req.body;
    if (purpose !== 'delete_account') {
      return res.status(400).json({ error: 'Некорректный purpose' });
    }
    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO auth_codes (email, code_hash, purpose, expires_at, ip_address) VALUES ($1, $2, $3, $4, $5)`,
      [req.user.email, codeHash, purpose, expiresAt, req.ip]
    );
    await sendCodeEmail(req.user.email, code, purpose);
    res.json({ ok: true, message: 'Код отправлен на почту' });
  } catch (err) {
    console.error('send-code error:', err);
    res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

// ── POST /api/auth/logout ──
router.post('/logout', requireAuth, async (req, res) => {
  await pool.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.user.session_id]);
  res.clearCookie('session', { domain: '.antviz.ru' });
  res.json({ ok: true });
});

// ── GET /api/auth/me ──
router.get('/me', requireAuth, async (req, res) => {
  res.json({
    id: req.user.id,
    email: req.user.email,
    displayName: req.user.display_name,
    photoUrl: req.user.photo_url,
    role: req.user.role,
    onboardingDone: req.user.onboarding_done,
  });
});

// ── POST /api/auth/onboarding-done ── помечает, что юзер прошёл приветственный онбординг
router.post('/onboarding-done', requireAuth, async (req, res) => {
  await pool.query('UPDATE users SET onboarding_done = TRUE WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

// ── GET /api/auth/ban-status ── проверка бана текущего юзера (для maintenance.js)
router.get('/ban-status', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM bans WHERE user_id = $1', [req.user.id]);
  if (rows.length === 0) return res.json({ banned: false });
  const ban = rows[0];
  const active = !ban.until || new Date(ban.until) > new Date();
  if (!active) return res.json({ banned: false });
  res.json({
    banned: true,
    reason: ban.reason,
    until: ban.until,
    showButton: ban.show_button,
    btnLabel: ban.btn_label,
    btnUrl: ban.btn_url,
  });
});

module.exports = router;
