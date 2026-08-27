const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { notifyTelegram } = require('../utils/notifyTelegram');

const router = express.Router();

function toClient(n) {
  return {
    id: n.id,
    title: n.title,
    text: n.text,
    read: n.is_read,
    createdAt: n.created_at,
  };
}

// ── GET /api/notifications ── список своих уведомлений (последние 100)
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [req.user.id]
  );
  res.json(rows.map(toClient));
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

// ── PATCH /api/notifications/read-all ── отметить все как прочитанные
router.patch('/read-all', requireAuth, async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE', [req.user.id]);
  res.json({ ok: true });
});

// ── POST /api/notifications/broadcast ── рассылка (только админ)
// target: 'all' | конкретный user_id
router.post('/broadcast', requireAdmin, async (req, res) => {
  try {
    const { target, title, text, buttonText, buttonUrl } = req.body;
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

    const values = userIds.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`).join(',');
    const params = userIds.flatMap(id => [id, title, text]);
    await pool.query(`INSERT INTO notifications (user_id, title, text) VALUES ${values}`, params);

    // Тем, у кого привязан Telegram — дублируем в бота (без await каждого:
    // рассылка на 100+ юзеров не должна ждать 100 последовательных запросов
    // к Vercel, все уходят параллельно). Кнопка — на конкретную страницу,
    // если вызывающий её передал (например admin/chats.html шлёт сюда же
    // при ответе в поддержке и указывает ссылку прямо на чат), иначе —
    // на общую страницу уведомлений.
    userIds.forEach((uid) => {
      notifyTelegram(uid, {
        title, text,
        buttonText: buttonText || 'Открыть',
        buttonUrl: buttonUrl || 'https://antviz.ru/profile/notifications.html',
      });
    });

    res.json({ ok: true, sent: userIds.length });
  } catch (err) {
    console.error('broadcast error:', err);
    res.status(500).json({ error: 'Не удалось разослать уведомление' });
  }
});

module.exports = router;
