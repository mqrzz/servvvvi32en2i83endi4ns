const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

function toClient(r) {
  return {
    id: r.id,
    userId: r.user_id,
    orderId: r.order_id,
    stars: r.stars,
    text: r.text,
    clientName: r.client_name,
    clientEmail: r.client_email,
    hidden: r.hidden,
    createdAt: r.created_at,
  };
}

// ── GET /api/reviews/admin/all ── все отзывы (только админ)
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
  res.json(rows.map(toClient));
});

// ── POST /api/reviews ── оставить отзыв на свой завершённый заказ
router.post('/', requireAuth, async (req, res) => {
  try {
    const { orderId, stars, text } = req.body;
    if (!orderId || !Number.isInteger(stars) || stars < 1 || stars > 5) {
      return res.status(400).json({ error: 'Заполните оценку (1-5) и заказ' });
    }
    const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
    const order = orderRows[0];
    if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Доступ запрещён' });
    if (order.status !== 5) return res.status(400).json({ error: 'Отзыв можно оставить только на завершённый заказ' });

    const { rows } = await pool.query(
      `INSERT INTO reviews (user_id, order_id, stars, text, client_name, client_email)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, orderId, stars, text || null, req.user.display_name, req.user.email]
    );
    await pool.query('UPDATE orders SET reviewed = TRUE WHERE id = $1', [orderId]);

    res.json(toClient(rows[0]));
  } catch (err) {
    console.error('create review error:', err);
    res.status(500).json({ error: 'Не удалось отправить отзыв' });
  }
});

// ── PATCH /api/reviews/:id ── показать/скрыть отзыв (только админ)
router.patch('/:id', requireAdmin, async (req, res) => {
  const { hidden } = req.body;
  const { rows } = await pool.query('UPDATE reviews SET hidden = $1 WHERE id = $2 RETURNING *', [!!hidden, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Отзыв не найден' });
  res.json(toClient(rows[0]));
});

// ── DELETE /api/reviews/:id ── удалить отзыв (только админ)
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM reviews WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Отзыв не найден' });
  res.json({ ok: true });
});

module.exports = router;
