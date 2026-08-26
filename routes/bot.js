const express = require('express');
const crypto = require('crypto');
const pool = require('../db/pool');
const { signServiceToken } = require('../utils/tokens');
const { toClientOrder } = require('./orders');

const router = express.Router();

// ── Доступ только для бота (Vercel-функции), общий секрет в заголовке ──
// Та же схема, что уже используется для вебхука ЮKассы (X-Payment-Secret) —
// у бота нет "текущего пользователя" в смысле cookie-сессии, поэтому
// авторизация на уровне сервер-сервер, а не через requireAuth/service-token.
function requireBotSecret(req, res, next) {
  const secret = req.headers['x-bot-secret'];
  if (!secret || secret !== process.env.BOT_API_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
router.use(requireBotSecret);

const TOKEN_TTL = { link: 15 * 60 * 1000, app_auth: 3 * 60 * 1000 };

function toClientNotification(n) {
  return { id: n.id, title: n.title, text: n.text, read: n.is_read, createdAt: n.created_at };
}

// ── POST /api/bot/link ── привязка аккаунта по токену из личного кабинета
// Тело: { token, chatId, username }
router.post('/link', async (req, res) => {
  const { token, chatId, username } = req.body || {};
  if (!token || !chatId) return res.status(400).json({ error: 'token и chatId обязательны' });

  const { rows } = await pool.query(
    `SELECT * FROM bot_tokens WHERE token = $1 AND purpose = 'link'`,
    [token]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'invalid_token' });
  const tok = rows[0];
  await pool.query('DELETE FROM bot_tokens WHERE token = $1', [token]); // одноразовый — сразу гасим

  if (new Date(tok.expires_at) < new Date()) return res.status(410).json({ error: 'expired_token' });

  const { rows: uRows } = await pool.query(
    `UPDATE users SET telegram_id = $1, telegram_username = $2, telegram_linked_at = now()
     WHERE id = $3 RETURNING id, display_name, role`,
    [chatId, username || null, tok.user_id]
  );
  if (uRows.length === 0) return res.status(404).json({ error: 'user_not_found' });
  const u = uRows[0];
  res.json({ uid: u.id, displayName: u.display_name, isAdmin: u.role === 'admin' });
});

// ── POST /api/bot/unlink ── отвязка по chatId (кнопка "Отвязать" в боте)
router.post('/unlink', async (req, res) => {
  const { chatId } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId обязателен' });
  await pool.query(
    `UPDATE users SET telegram_id = NULL, telegram_username = NULL, telegram_linked_at = NULL WHERE telegram_id = $1`,
    [chatId]
  );
  res.json({ ok: true });
});

// ── GET /api/bot/user-by-chat/:chatId ── найти uid по chatId (аналог findUidByChat)
router.get('/user-by-chat/:chatId', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, display_name, role FROM users WHERE telegram_id = $1',
    [req.params.chatId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_linked' });
  const u = rows[0];
  res.json({ uid: u.id, displayName: u.display_name, isAdmin: u.role === 'admin' });
});

// ── POST /api/bot/app-link-code ── одноразовый код для входа в мини-апп из бота
// Тело: { uid } → { code }. tg-enter.html обменивает code на реальную сессию
// через POST /api/auth/bot-login (там же, на antviz-backend, не через бота).
router.post('/app-link-code', async (req, res) => {
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid обязателен' });
  const code = crypto.randomUUID();
  await pool.query(
    `INSERT INTO bot_tokens (token, user_id, purpose, expires_at) VALUES ($1,$2,'app_auth',$3)`,
    [code, uid, new Date(Date.now() + TOKEN_TTL.app_auth)]
  );
  res.json({ code });
});

// ── POST /api/bot/service-token ── короткоживущий токен для оплаты от лица юзера
// (та же механика, что POST /api/auth/service-token для браузера, только тут
// личность подтверждает не cookie-сессия, а секрет бота + прямое указание uid)
router.post('/service-token', async (req, res) => {
  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid обязателен' });
  const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [uid]);
  if (rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
  res.json({ token: signServiceToken(uid) });
});

// ── GET /api/bot/profile-summary/:uid ── сводка для шапки "Профиль" в боте
router.get('/profile-summary/:uid', async (req, res) => {
  const { uid } = req.params;
  const { rows: uRows } = await pool.query('SELECT display_name FROM users WHERE id = $1', [uid]);
  if (uRows.length === 0) return res.status(404).json({ error: 'user_not_found' });

  const { rows: oRows } = await pool.query('SELECT status, support_active, support_expires_at FROM orders WHERE user_id = $1', [uid]);
  let activeOrders = 0, supportSites = 0;
  const now = new Date();
  oRows.forEach(o => {
    if (o.status !== 5) activeOrders++;
    if (o.support_active && o.support_expires_at && new Date(o.support_expires_at) > now) supportSites++;
  });

  res.json({ displayName: uRows[0].display_name, activeOrders, supportSites });
});

// ── GET /api/bot/orders?uid=&status=&limit= ── список заказов юзера
router.get('/orders', async (req, res) => {
  const { uid, status, limit } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid обязателен' });
  const params = [uid];
  let sql = 'SELECT * FROM orders WHERE user_id = $1';
  if (status !== undefined) { params.push(Number(status)); sql += ` AND status = $${params.length}`; }
  sql += ' ORDER BY created_at DESC';
  if (limit) { params.push(Number(limit)); sql += ` LIMIT $${params.length}`; }
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(toClientOrder));
});

// ── GET /api/bot/orders/:id?uid= ── один заказ, с проверкой владельца
router.get('/orders/:id', async (req, res) => {
  const { uid } = req.query;
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  if (uid && rows[0].user_id !== uid) return res.status(403).json({ error: 'forbidden' });
  res.json(toClientOrder(rows[0]));
});

// ── GET /api/bot/notifications?uid=&limit= ──
router.get('/notifications', async (req, res) => {
  const { uid, limit } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid обязателен' });
  const { rows } = await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [uid, Number(limit) || 3]
  );
  res.json(rows.map(toClientNotification));
});

// ── GET /api/bot/stats ── агрегированная статистика для админ-меню бота
router.get('/stats', async (req, res) => {
  const { rows: statusRows } = await pool.query('SELECT status, COUNT(*)::int AS c FROM orders GROUP BY status');
  const counts = { total: 0, waitingPay: 0, waitingTop: 0, done: 0, active: 0 };
  statusRows.forEach(r => {
    counts.total += r.c;
    if (r.status === -1) counts.waitingPay += r.c;
    else if (r.status === 6) counts.waitingTop += r.c;
    else if (r.status === 5) counts.done += r.c;
    else counts.active += r.c;
  });
  const { rows: linkedRows } = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE telegram_id IS NOT NULL');
  res.json({ ...counts, linked: linkedRows[0].c });
});

// ── GET /api/bot/broadcast-targets ── все chatId привязанных пользователей
router.get('/broadcast-targets', async (req, res) => {
  const { rows } = await pool.query('SELECT id, telegram_id FROM users WHERE telegram_id IS NOT NULL');
  res.json(rows.map(r => ({ uid: r.id, chatId: r.telegram_id })));
});

// ── GET/POST /api/bot/kv/:key ── простое key-value для состояния бота
// (техработы бота, "жду текст рассылки от админа" — на Vercel нет своего
// файлового хранилища как .maintenance на VPS, поэтому храним в БД)
router.get('/kv/:key', async (req, res) => {
  const { rows } = await pool.query('SELECT value FROM kv_settings WHERE key = $1', [req.params.key]);
  res.json({ value: rows.length ? rows[0].value : null });
});
router.post('/kv/:key', async (req, res) => {
  const { value } = req.body || {};
  await pool.query(
    `INSERT INTO kv_settings (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [req.params.key, JSON.stringify(value)]
  );
  res.json({ ok: true });
});
router.delete('/kv/:key', async (req, res) => {
  await pool.query('DELETE FROM kv_settings WHERE key = $1', [req.params.key]);
  res.json({ ok: true });
});

// ── GET /api/bot/tg-chat-for-user/:uid ── telegram_id по uid (для notify.js —
// после того как он сам проверил через /api/auth/whoami, что зовущий админ)
router.get('/tg-chat-for-user/:uid', async (req, res) => {
  const { rows } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [req.params.uid]);
  if (rows.length === 0) return res.status(404).json({ error: 'user_not_found' });
  res.json({ chatId: rows[0].telegram_id });
});

module.exports = router;
