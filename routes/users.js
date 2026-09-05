const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// ── GET /api/users ── список всех пользователей (только админ, для рассылок и т.д.)
router.get('/', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at DESC`
  );
  res.json(rows.map(u => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    createdAt: u.created_at,
  })));
});

// ── GET /api/users/admin/all ── обогащённый список для страницы «Клиенты»:
// сколько заказов, сколько потрачено, когда был последний заказ, привязан ли
// телеграм, забанен ли — одним запросом, вместо ручного join по 3 страницам.
// ВАЖНО: должен идти раньше '/', иначе не пересекается с ним (у GET '/' нет :id).
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      u.id, u.email, u.display_name, u.role, u.created_at,
      u.telegram_id, u.telegram_username,
      COALESCE(o.orders_count, 0) AS orders_count,
      COALESCE(o.total_spent, 0) AS total_spent,
      o.last_order_at,
      b.reason AS ban_reason, b.until AS ban_until, b.banned_at
    FROM users u
    LEFT JOIN (
      SELECT user_id,
             COUNT(*)::int AS orders_count,
             SUM(paid_amount) AS total_spent,
             MAX(created_at) AS last_order_at
      FROM orders
      WHERE status != -1
      GROUP BY user_id
    ) o ON o.user_id = u.id
    LEFT JOIN bans b ON b.user_id = u.id
    ORDER BY u.created_at DESC
  `);
  res.json(rows.map(u => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    createdAt: u.created_at,
    telegramLinked: !!u.telegram_id,
    telegramUsername: u.telegram_username,
    ordersCount: u.orders_count,
    totalSpent: Number(u.total_spent) || 0,
    lastOrderAt: u.last_order_at,
    banned: !!u.banned_at,
    banReason: u.ban_reason,
    banUntil: u.ban_until,
  })));
});

// ── DELETE /api/users/:id ── полное удаление пользователя (только админ) ──
// Каскадно (ON DELETE CASCADE в schema.sql) удаляет всё, что на него
// ссылается: заказы, тикеты+сообщения, заявки на обслуживание, сессии,
// уведомления, passkeys, привязку к боту. Необратимо.
router.delete('/:id', requireAdmin, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить свой собственный аккаунт админа отсюда' });
  }
  try {
    const { rows } = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /users/:id:', err);
    res.status(500).json({ error: 'Не удалось удалить пользователя' });
  }
});

module.exports = router;
