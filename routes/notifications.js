const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/requireAuth');

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

module.exports = router;
