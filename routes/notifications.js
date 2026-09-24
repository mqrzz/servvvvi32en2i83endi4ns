const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { KEEP_LAST } = require('../utils/notifications');
const { TYPES, getUserPrefs, saveUserPrefs, deliverNotifications } = require('../utils/notify');

const router = express.Router();

function toClient(n) {
  return {
    id: n.id,
    title: n.title,
    text: n.text,
    type: n.type || 'system',
    link: n.link || null,
    read: n.is_read,
    createdAt: n.created_at,
  };
}

// ── GET /api/notifications ── список своих уведомлений (храним только
// последние 10 на пользователя — старые реально удаляются, см.
// utils/notifications.js)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [req.user.id, KEEP_LAST]
  );
  res.json(rows.map(toClient));
});

// ── GET /api/notifications/prefs ── настройки каналов (Telegram / e-mail) по типам
router.get('/prefs', requireAuth, async (req, res) => {
  try {
    const prefs = await getUserPrefs(req.user.id);
    res.json({
      prefs,
      types: TYPES,
      telegramLinked: !!req.user.telegram_id,
      email: req.user.email,
    });
  } catch (err) {
    console.error('GET /notifications/prefs:', err);
    res.status(500).json({ error: 'Не удалось загрузить настройки уведомлений' });
  }
});

// ── PUT /api/notifications/prefs ── сохранить настройки; тело: { prefs: { order:{telegram,email}, ... } }
router.put('/prefs', requireAuth, async (req, res) => {
  try {
    const raw = req.body && req.body.prefs;
    if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Некорректные настройки' });
    const prefs = await saveUserPrefs(req.user.id, raw);
    res.json({ prefs });
  } catch (err) {
    console.error('PUT /notifications/prefs:', err);
    res.status(500).json({ error: 'Не удалось сохранить настройки' });
  }
});

// ── PATCH /api/notifications/read-all ── отметить все как прочитанные
// (объявлен ДО /:id/read — иначе "read-all" ушёл бы туда как :id)
router.patch('/read-all', requireAuth, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
  res.json({ ok: true });
});

// ── PATCH /api/notifications/:id/read ── отметить одно как прочитанное
router.patch('/:id/read', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Уведомление не найдено' });
  res.json({ ok: true });
});

// ── POST /api/notifications/broadcast ── рассылка (только админ)
// target: 'all' | конкретный user_id
// Необязательные поля: type ('order'|'support'|'service'|'system'), link (путь внутри
// сайта, куда ведёт клик по уведомлению). Если type не передан — определяется
// автоматически (см. utils/notify.js). Доставка в Telegram и e-mail учитывает
// настройки конкретного пользователя.
router.post('/broadcast', requireAdmin, async (req, res) => {
  try {
    const { target, title, text, buttonText, buttonUrl, type, link } = req.body;
    if (!title || !text) return res.status(400).json({ error: 'Заполните тему и текст' });

    let userIds;
    if (target === 'all') {
      const { rows } = await pool.query('SELECT id FROM users');
      userIds = rows.map(r => r.id);
    } else {
      const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [target]);
      if (rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
      userIds = [target];
    }

    if (!userIds.length) return res.status(400).json({ error: 'Нет получателей' });

    // Массовая рассылка из админки без явного типа — это «системное» сообщение,
    // а не статус заказа (иначе по словам в тексте могло бы определиться как заказ).
    const effectiveType = type || (target === 'all' ? 'system' : undefined);
    const { sent } = await deliverNotifications(userIds, { title, text, buttonText, buttonUrl, type: effectiveType, link });

    res.json({ ok: true, sent });
  } catch (err) {
    console.error('broadcast error:', err);
    res.status(500).json({ error: 'Не удалось разослать уведомление' });
  }
});

module.exports = router;
