const express = require('express');
const crypto = require('crypto');
const disposableDomains = require('disposable-email-domains');
const UAParser = require('ua-parser-js');
const QRCode = require('qrcode');
const pool = require('../db/pool');
const { generateCode, hashCode, verifyCode } = require('../utils/codes');
const { sendCodeEmail, sendNewDeviceLoginEmail, sendAccountDeletedEmail } = require('../utils/mailer');
const { signSessionToken, hashToken, sessionExpiryDate, SESSION_DAYS, signServiceToken } = require('../utils/tokens');
const { sendCodeLimiter, verifyCodeLimiter } = require('../middleware/rateLimiters');
const { requireAuth, requireUserOrService } = require('../middleware/requireAuth');
const totp = require('../utils/totp');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  RP_NAME,
  RP_ID,
  ORIGIN,
} = require('../utils/webauthn');
const { getYandexAuthUrl, exchangeYandexCode, fetchYandexUser } = require('../utils/yandex');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const disposableSet = new Set(disposableDomains);

function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? disposableSet.has(domain) : false;
}

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

function publicUser(user) {
  return { id: user.id, email: user.email, displayName: user.display_name, photoUrl: user.photo_url, role: user.role };
}

// Генерирует ОДИН резервный код (не пачку), хэширует и сохраняет.
// Возвращает исходный код — показать юзеру ровно один раз.
async function issueRecoveryCode(client, userId) {
  const code = crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,4}/g).join('-'); // напр. "A1B2-C3D4-E5"
  const hash = hashCode(code);
  await client.query('UPDATE users SET recovery_code_hash = $1, recovery_code_created_at = now() WHERE id = $2', [hash, userId]);
  return code;
}

// ── POST /api/auth/register ── создать аккаунт (email не подтверждён), отправить код
// Пароль больше не запрашиваем — только имя и email.
router.post('/register', sendCodeLimiter, async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    if (isDisposableEmail(email)) {
      return res.status(400).json({ error: 'Временные (одноразовые) email не поддерживаются, укажите постоянный адрес' });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await pool.query('SELECT id, email_verified FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0 && existing.rows[0].email_verified) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован, войдите' });
    }

    if (existing.rows.length > 0) {
      await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [name?.trim() || 'Пользователь', existing.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO users (email, display_name, email_verified) VALUES ($1, $2, FALSE)`,
        [normalizedEmail, name?.trim() || 'Пользователь']
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
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('register/verify error:', err);
    res.status(500).json({ error: 'Не удалось подтвердить код' });
  } finally {
    client.release();
  }
});

// =====================================================
// ВХОД — email обязателен как идентификатор на первом шаге
// (сам вход дальше может быть кодом с почты, TOTP или резервным кодом)
// =====================================================

// ── POST /api/auth/login/start ── проверить, что аккаунт есть, отправить код на почту,
// и сказать фронту, какие альтернативные способы у аккаунта включены
router.post('/login/start', sendCodeLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Некорректный email' });
    const normalizedEmail = email.trim().toLowerCase();

    const { rows } = await pool.query(
      'SELECT id, email_verified, totp_enabled, recovery_code_hash FROM users WHERE email = $1',
      [normalizedEmail]
    );
    if (rows.length === 0 || !rows[0].email_verified) {
      // Не подтверждаем/опровергаем существование аккаунта явно в тексте ошибки —
      // но всё равно приходится сказать, иначе непонятно, что делать дальше.
      return res.status(404).json({ error: 'Аккаунт с таким email не найден' });
    }
    const user = rows[0];

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await pool.query(
      `INSERT INTO auth_codes (email, code_hash, purpose, expires_at, ip_address) VALUES ($1, $2, 'login', $3, $4)`,
      [normalizedEmail, codeHash, expiresAt, req.ip]
    );
    await sendCodeEmail(normalizedEmail, code, 'login');

    res.json({
      ok: true,
      totpAvailable: user.totp_enabled,
      recoveryAvailable: Boolean(user.recovery_code_hash),
    });
  } catch (err) {
    console.error('login/start error:', err);
    res.status(500).json({ error: 'Не удалось отправить код' });
  }
});

async function finishCodeLogin(req, res, { normalizedEmail, purpose, verifyField, onSuccessExtra }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE email = $1 AND email_verified = TRUE', [normalizedEmail]);
    if (userRows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Аккаунт не найден' });
    }
    const user = userRows[0];

    const ban = await checkBan(client, user.id);
    if (ban) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Аккаунт заблокирован', reason: ban.reason, until: ban.until });
    }

    const { token, deviceName } = await createSession(client, user.id, req);
    if (onSuccessExtra) await onSuccessExtra(client, user);
    await client.query('COMMIT');

    setSessionCookie(res, token);
    sendNewDeviceLoginEmail(user.email, {
      deviceName,
      ipAddress: req.ip,
      time: new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }),
    }).catch((e) => console.error('Не удалось отправить письмо о входе:', e));

    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`${purpose} login error:`, err);
    res.status(500).json({ error: 'Не удалось войти' });
  } finally {
    client.release();
  }
}

// ── POST /api/auth/login/verify-code ── вход кодом с почты (основной способ)
router.post('/login/verify-code', verifyCodeLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email и код обязательны' });
  const normalizedEmail = email.trim().toLowerCase();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: codeRows } = await client.query(
      `SELECT * FROM auth_codes WHERE email = $1 AND purpose = 'login' AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [normalizedEmail]
    );
    if (codeRows.length === 0) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ error: 'Код не найден, запросите новый' }); }
    const authCode = codeRows[0];
    if (new Date(authCode.expires_at) < new Date()) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ error: 'Код истёк, запросите новый' }); }
    if (authCode.attempts >= authCode.max_attempts) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ error: 'Превышено число попыток, запросите новый код' }); }
    if (!verifyCode(code.trim(), authCode.code_hash)) {
      await client.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [authCode.id]);
      await client.query('COMMIT');
      client.release();
      return res.status(400).json({ error: 'Неверный код' });
    }
    await client.query('UPDATE auth_codes SET used_at = now() WHERE id = $1', [authCode.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('login/verify-code error:', err);
    return res.status(500).json({ error: 'Не удалось проверить код' });
  }
  client.release();

  return finishCodeLogin(req, res, { normalizedEmail, purpose: 'email-code' });
});

// ── POST /api/auth/login/verify-totp ── вход кодом из Authenticator вместо почты
// (на случай, если человек не может получить письмо, но помнит email и телефон с ним)
router.post('/login/verify-totp', verifyCodeLimiter, async (req, res) => {
  const { email, token } = req.body;
  if (!email || !token) return res.status(400).json({ error: 'Email и код обязательны' });
  const normalizedEmail = email.trim().toLowerCase();

  const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE email = $1', [normalizedEmail]);
  if (rows.length === 0 || !rows[0].totp_enabled) {
    return res.status(400).json({ error: 'Authenticator не подключён для этого аккаунта' });
  }
  if (!totp.verifyToken(rows[0].totp_secret, token)) {
    return res.status(400).json({ error: 'Неверный код' });
  }

  return finishCodeLogin(req, res, { normalizedEmail, purpose: 'totp' });
});

// ── POST /api/auth/login/verify-recovery ── вход резервным кодом (крайний случай:
// нет доступа ни к почте, ни к Authenticator-устройству). Код одноразовый — сгорает сразу.
router.post('/login/verify-recovery', verifyCodeLimiter, async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email и код обязательны' });
  const normalizedEmail = email.trim().toLowerCase();

  const { rows } = await pool.query('SELECT recovery_code_hash FROM users WHERE email = $1', [normalizedEmail]);
  if (rows.length === 0 || !rows[0].recovery_code_hash) {
    return res.status(400).json({ error: 'Резервный код не выпущен для этого аккаунта' });
  }
  if (!verifyCode(code.trim().toUpperCase(), rows[0].recovery_code_hash)) {
    return res.status(400).json({ error: 'Неверный резервный код' });
  }

  // Сжигаем код сразу, вне зависимости от исхода дальше — он одноразовый.
  return finishCodeLogin(req, res, {
    normalizedEmail,
    purpose: 'recovery-code',
    onSuccessExtra: async (client, user) => {
      await client.query('UPDATE users SET recovery_code_hash = NULL, recovery_code_created_at = NULL WHERE id = $1', [user.id]);
    },
  });
});

// =====================================================
// ЯНДЕКС OAUTH
// Правило слияния аккаунтов: единственный идентификатор — email.
// Если Яндекс отдал email, который уже есть в БД — просто привязываем
// yandex_id к существующему юзеру, а не плодим второй аккаунт.
// =====================================================

router.get('/yandex/start', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('yandex_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(getYandexAuthUrl(state));
});

router.get('/yandex/callback', async (req, res) => {
  const frontendBase = process.env.FRONTEND_ORIGIN || 'https://antviz.ru';
  try {
    const { code, state } = req.query;
    const expectedState = req.cookies?.yandex_oauth_state;
    res.clearCookie('yandex_oauth_state');
    if (!code || !state || state !== expectedState) {
      return res.redirect(`${frontendBase}/auth.html?yandex_error=state`);
    }

    const { access_token } = await exchangeYandexCode(code);
    const yUser = await fetchYandexUser(access_token);
    const yandexId = String(yUser.id);
    const email = (yUser.default_email || yUser.emails?.[0] || '').trim().toLowerCase();
    const displayName = yUser.display_name || yUser.real_name || yUser.login || 'Пользователь';

    if (!email) {
      // Яндекс не отдал почту (скрыта настройками приватности) — без email
      // сливать/создавать аккаунт нельзя, иначе потом эту же почту нельзя
      // будет корректно привязать. Просим войти email-способом и привязать
      // Яндекс вручную из настроек, где мы явно попросим разрешить emai.
      return res.redirect(`${frontendBase}/auth.html?yandex_error=no_email`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let { rows } = await client.query('SELECT * FROM users WHERE yandex_id = $1', [yandexId]);
      let user = rows[0];
      let isNewUser = false;

      if (!user) {
        const byEmail = await client.query('SELECT * FROM users WHERE email = $1', [email]);
        if (byEmail.rows.length > 0) {
          // Уже есть аккаунт с этим email (регистрировался через почту) — привязываем Яндекс к нему.
          await client.query('UPDATE users SET yandex_id = $1 WHERE id = $2', [yandexId, byEmail.rows[0].id]);
          user = { ...byEmail.rows[0], yandex_id: yandexId };
        } else {
          const inserted = await client.query(
            `INSERT INTO users (email, display_name, email_verified, yandex_id) VALUES ($1, $2, TRUE, $3) RETURNING *`,
            [email, displayName, yandexId]
          );
          user = inserted.rows[0];
          isNewUser = true;
        }
      }

      const ban = await checkBan(client, user.id);
      if (ban) {
        await client.query('ROLLBACK');
        client.release();
        return res.redirect(`${frontendBase}/auth.html?yandex_error=banned`);
      }

      const { token } = await createSession(client, user.id, req);
      await client.query('COMMIT');
      client.release();

      setSessionCookie(res, token);
      res.redirect(`${frontendBase}${isNewUser ? '/welcome.html' : '/profile.html'}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
  } catch (err) {
    console.error('yandex/callback error:', err);
    res.redirect(`${frontendBase}/auth.html?yandex_error=unknown`);
  }
});

// =====================================================
// PASSKEY (WebAuthn)
// =====================================================

const CHALLENGE_TTL_MS = 3 * 60 * 1000;

async function storeChallenge(userId, challenge, purpose) {
  await pool.query(
    `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at) VALUES ($1, $2, $3, $4)`,
    [userId, challenge, purpose, new Date(Date.now() + CHALLENGE_TTL_MS)]
  );
}

async function takeChallenge(id, purpose) {
  const { rows } = await pool.query(
    `DELETE FROM webauthn_challenges WHERE id = $1 AND purpose = $2 AND expires_at > now() RETURNING *`,
    [id, purpose]
  );
  return rows[0] || null;
}

// Подключение ключа — только уже залогиненным пользователем, из настроек
router.post('/passkey/register-options', requireAuth, async (req, res) => {
  try {
    const { rows: existing } = await pool.query('SELECT credential_id FROM passkeys WHERE user_id = $1', [req.user.id]);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: Buffer.from(req.user.id),
      userName: req.user.email,
      userDisplayName: req.user.display_name,
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.credential_id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const { rows: chRows } = await pool.query(
      `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at) VALUES ($1,$2,'register',$3) RETURNING id`,
      [req.user.id, options.challenge, new Date(Date.now() + CHALLENGE_TTL_MS)]
    );
    res.json({ options, challengeId: chRows[0].id });
  } catch (err) {
    console.error('passkey/register-options error:', err);
    res.status(500).json({ error: 'Не удалось начать подключение ключа' });
  }
});

router.post('/passkey/register-verify', requireAuth, async (req, res) => {
  try {
    const { challengeId, response, deviceName } = req.body;
    const ch = await takeChallenge(challengeId, 'register');
    if (!ch || ch.user_id !== req.user.id) return res.status(400).json({ error: 'Запрос устарел, попробуйте снова' });

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Не удалось подтвердить ключ' });
    }
    const { credential } = verification.registrationInfo;
    await pool.query(
      `INSERT INTO passkeys (user_id, credential_id, public_key, counter, device_name) VALUES ($1,$2,$3,$4,$5)`,
      [req.user.id, credential.id, Buffer.from(credential.publicKey).toString('base64url'), credential.counter, deviceName || deviceNameFromUA(req.headers['user-agent'])]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('passkey/register-verify error:', err);
    res.status(500).json({ error: 'Не удалось сохранить ключ' });
  }
});

router.get('/passkey/list', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, device_name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ passkeys: rows });
});

router.delete('/passkey/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM passkeys WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
});

// Вход по ключу — дискаверабл (без email, браузер сам предлагает сохранённый ключ)
router.post('/passkey/login-options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: 'preferred',
    });
    const { rows } = await pool.query(
      `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at) VALUES (NULL,$1,'login',$2) RETURNING id`,
      [options.challenge, new Date(Date.now() + CHALLENGE_TTL_MS)]
    );
    res.json({ options, challengeId: rows[0].id });
  } catch (err) {
    console.error('passkey/login-options error:', err);
    res.status(500).json({ error: 'Не удалось начать вход по ключу' });
  }
});

router.post('/passkey/login-verify', async (req, res) => {
  const client = await pool.connect();
  try {
    const { challengeId, response } = req.body;
    const ch = await takeChallenge(challengeId, 'login');
    if (!ch) { client.release(); return res.status(400).json({ error: 'Запрос устарел, попробуйте снова' }); }

    const { rows: pkRows } = await client.query('SELECT * FROM passkeys WHERE credential_id = $1', [response.id]);
    if (pkRows.length === 0) { client.release(); return res.status(400).json({ error: 'Ключ не распознан' }); }
    const passkey = pkRows[0];

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: ch.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, 'base64url'),
        counter: Number(passkey.counter),
      },
    });
    if (!verification.verified) { client.release(); return res.status(400).json({ error: 'Не удалось подтвердить ключ' }); }

    await client.query('BEGIN');
    await client.query('UPDATE passkeys SET counter = $1, last_used_at = now() WHERE id = $2', [verification.authenticationInfo.newCounter, passkey.id]);

    const { rows: userRows } = await client.query('SELECT * FROM users WHERE id = $1', [passkey.user_id]);
    const user = userRows[0];
    const ban = await checkBan(client, user.id);
    if (ban) { await client.query('ROLLBACK'); client.release(); return res.status(403).json({ error: 'Аккаунт заблокирован' }); }

    const { token } = await createSession(client, user.id, req);
    await client.query('COMMIT');
    client.release();

    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('passkey/login-verify error:', err);
    res.status(500).json({ error: 'Не удалось войти по ключу' });
  }
});

// =====================================================
// AUTHENTICATOR (TOTP) — 2FA + резервный код
// =====================================================

// Шаг 1: сгенерировать секрет и QR, но ЕЩЁ НЕ включать — включаем только
// после подтверждения кодом в /totp/confirm, иначе человек может случайно
// заблокировать себе вход неправильно отсканированным QR.
router.post('/totp/setup', requireAuth, async (req, res) => {
  try {
    const secret = totp.generateSecretBase32();
    await pool.query('UPDATE users SET totp_secret = $1, totp_enabled = FALSE WHERE id = $2', [secret, req.user.id]);
    const url = totp.otpauthUrl(secret, req.user.email);
    const qrDataUrl = await QRCode.toDataURL(url);
    res.json({ secret, otpauthUrl: url, qrDataUrl });
  } catch (err) {
    console.error('totp/setup error:', err);
    res.status(500).json({ error: 'Не удалось начать подключение Authenticator' });
  }
});

router.post('/totp/confirm', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    const { rows } = await pool.query('SELECT totp_secret FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]?.totp_secret) return res.status(400).json({ error: 'Сначала начните подключение' });
    if (!totp.verifyToken(rows[0].totp_secret, token)) return res.status(400).json({ error: 'Неверный код' });

    await pool.query('UPDATE users SET totp_enabled = TRUE WHERE id = $1', [req.user.id]);
    const recoveryCode = await issueRecoveryCode(pool, req.user.id);
    res.json({ ok: true, recoveryCode });
  } catch (err) {
    console.error('totp/confirm error:', err);
    res.status(500).json({ error: 'Не удалось подтвердить Authenticator' });
  }
});

router.post('/totp/disable', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]?.totp_enabled) return res.status(400).json({ error: 'Authenticator не подключён' });
    if (!totp.verifyToken(rows[0].totp_secret, token)) return res.status(400).json({ error: 'Неверный код' });

    await pool.query(
      `UPDATE users SET totp_secret = NULL, totp_enabled = FALSE, recovery_code_hash = NULL, recovery_code_created_at = NULL WHERE id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('totp/disable error:', err);
    res.status(500).json({ error: 'Не удалось отключить Authenticator' });
  }
});

// Перевыпуск резервного кода — старый (если был) сразу перестаёт действовать
router.post('/totp/recovery-code/regenerate', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    const { rows } = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0]?.totp_enabled) return res.status(400).json({ error: 'Authenticator не подключён' });
    if (!totp.verifyToken(rows[0].totp_secret, token)) return res.status(400).json({ error: 'Неверный код' });

    const recoveryCode = await issueRecoveryCode(pool, req.user.id);
    res.json({ ok: true, recoveryCode });
  } catch (err) {
    console.error('totp/recovery-code/regenerate error:', err);
    res.status(500).json({ error: 'Не удалось перевыпустить резервный код' });
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
    createdAt: req.user.created_at,
    telegramId: req.user.telegram_id,
    telegramUsername: req.user.telegram_username,
  });
});

// ── GET /api/auth/security-overview ── список подключённых способов входа для страницы Безопасность
router.get('/security-overview', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT yandex_id, totp_enabled, recovery_code_hash FROM users WHERE id = $1',
    [req.user.id]
  );
  const { rows: passkeys } = await pool.query(
    'SELECT id, device_name, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  const u = rows[0];
  res.json({
    email: req.user.email,
    yandexLinked: Boolean(u.yandex_id),
    totpEnabled: u.totp_enabled,
    recoveryCodeIssued: Boolean(u.recovery_code_hash),
    passkeys,
  });
});

// ── POST /api/auth/onboarding-done ──
router.post('/onboarding-done', requireAuth, async (req, res) => {
  await pool.query('UPDATE users SET onboarding_done = TRUE WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
});

// ── GET /api/auth/ban-status ──
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

// ── PUT /api/auth/profile ──
router.put('/profile', requireAuth, async (req, res) => {
  const { displayName } = req.body;
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'Введите имя' });
  }
  await pool.query('UPDATE users SET display_name = $1 WHERE id = $2', [displayName.trim(), req.user.id]);
  res.json({ ok: true, displayName: displayName.trim() });
});

// ── POST /api/auth/delete-account ──
router.post('/delete-account', verifyCodeLimiter, requireAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Введите код' });

    const { rows: codeRows } = await pool.query(
      `SELECT * FROM auth_codes WHERE email = $1 AND purpose = 'delete_account' AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.email]
    );
    if (codeRows.length === 0) return res.status(400).json({ error: 'Код не найден, запросите новый' });
    const authCode = codeRows[0];
    if (new Date(authCode.expires_at) < new Date()) return res.status(400).json({ error: 'Код истёк, запросите новый' });
    if (authCode.attempts >= authCode.max_attempts) return res.status(400).json({ error: 'Превышено число попыток, запросите новый код' });
    if (!verifyCode(code.trim(), authCode.code_hash)) {
      await pool.query('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1', [authCode.id]);
      return res.status(400).json({ error: 'Неверный код' });
    }
    await pool.query('UPDATE auth_codes SET used_at = now() WHERE id = $1', [authCode.id]);

    await pool.query('DELETE FROM users WHERE id = $1', [req.user.id]);

    sendAccountDeletedEmail(req.user.email).catch((e) => console.error('Не удалось отправить письмо об удалении:', e));

    res.clearCookie('session', { domain: '.antviz.ru' });
    res.json({ ok: true });
  } catch (err) {
    console.error('delete-account error:', err);
    res.status(500).json({ error: 'Не удалось удалить аккаунт' });
  }
});

// ── POST /api/auth/service-token ──
router.post('/service-token', requireAuth, async (req, res) => {
  try {
    res.json({ token: signServiceToken(req.user.id) });
  } catch (err) {
    console.error('service-token error:', err);
    res.status(500).json({ error: 'Не удалось выдать токен' });
  }
});

// ── POST /api/auth/bot-login ── вход из мини-аппа Telegram по одноразовому коду от бота
router.post('/bot-login', async (req, res) => {
  const client = await pool.connect();
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code обязателен' });

    const { rows } = await client.query(
      `SELECT * FROM bot_tokens WHERE token = $1 AND purpose = 'app_auth'`,
      [code]
    );
    if (rows.length === 0) return res.status(401).json({ error: 'Код недействителен или уже использован' });
    const tok = rows[0];
    await client.query('DELETE FROM bot_tokens WHERE token = $1', [code]);

    if (new Date(tok.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Код истёк, откройте кнопку в боте ещё раз' });
    }

    const { rows: uRows } = await client.query('SELECT * FROM users WHERE id = $1', [tok.user_id]);
    if (uRows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    const user = uRows[0];

    await client.query('BEGIN');
    const ban = await checkBan(client, user.id);
    if (ban) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Аккаунт заблокирован', reason: ban.reason, until: ban.until });
    }
    const { token } = await createSession(client, user.id, req);
    await client.query('COMMIT');

    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('bot-login error:', err);
    res.status(500).json({ error: 'Не удалось войти' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/auth/telegram-link ──
router.patch('/telegram-link', requireUserOrService, async (req, res) => {
  try {
    const { tgChatId, tgUsername } = req.body || {};
    if (!tgChatId) return res.status(400).json({ error: 'tgChatId обязателен' });
    await pool.query(
      `UPDATE users SET telegram_id = $1, telegram_username = $2, telegram_linked_at = now() WHERE id = $3`,
      [tgChatId, tgUsername || null, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('telegram-link error:', err);
    res.status(500).json({ error: 'Не удалось привязать Telegram' });
  }
});

router.post('/telegram-link-token', requireAuth, async (req, res) => {
  try {
    const token = crypto.randomUUID();
    await pool.query(
      `INSERT INTO bot_tokens (token, user_id, purpose, expires_at) VALUES ($1,$2,'link',$3)`,
      [token, req.user.id, new Date(Date.now() + 15 * 60 * 1000)]
    );
    res.json({ token });
  } catch (err) {
    console.error('telegram-link-token error:', err);
    res.status(500).json({ error: 'Не удалось создать ссылку привязки' });
  }
});

router.post('/telegram-unlink', requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users SET telegram_id = NULL, telegram_username = NULL, telegram_linked_at = NULL WHERE id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('telegram-unlink error:', err);
    res.status(500).json({ error: 'Не удалось отвязать Telegram' });
  }
});

router.get('/whoami', requireUserOrService, async (req, res) => {
  try {
    res.json({ uid: req.user.id, role: req.user.role });
  } catch (err) {
    console.error('whoami error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
