const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, requireUserOrService } = require('../middleware/requireAuth');

const router = express.Router();

function toClient(t) {
  return {
    id: t.id,
    orderId: t.order_id,
    userName: t.user_name,
    userEmail: t.user_email,
    title: t.title,
    description: t.description,
    images: t.images,
    orderSiteType: t.order_site_type,
    orderTariff: t.order_tariff,
    orderDomain: t.order_domain,
    billing: t.billing,
    adminReply: t.admin_reply,
    status: t.status,
    rating: t.rating,
    paid: t.paid,
    paidAt: t.paid_at,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

// ── GET /api/service-tickets/admin/all ── все заявки (только админ)
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM service_tickets ORDER BY created_at DESC');
  res.json(rows.map(toClient));
});

// ── GET /api/service-tickets ── свои заявки (опционально фильтр по orderId через query)
router.get('/', requireAuth, async (req, res) => {
  const { orderId } = req.query;
  const params = [req.user.id];
  let sql = 'SELECT * FROM service_tickets WHERE user_id = $1';
  if (orderId) {
    params.push(orderId);
    sql += ' AND order_id = $2';
  }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await pool.query(sql, params);
  res.json(rows.map(toClient));
});

// ── GET /api/service-tickets/:id ── один тикет (владелец, включая доступ через сервисный токен)
router.get('/:id', requireUserOrService, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM service_tickets WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  const ticket = rows[0];
  if (ticket.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json(toClient(ticket));
});

// ── POST /api/service-tickets ── создать заявку на доработку
router.post('/', requireAuth, async (req, res) => {
  try {
    const { orderId, title, description, images, orderSiteType, orderTariff, orderDomain, billing } = req.body;
    if (!orderId || !title) return res.status(400).json({ error: 'Заполните обязательные поля' });

    // Проверяем, что заказ реально принадлежит этому юзеру
    const { rows: orderRows } = await pool.query('SELECT user_id FROM orders WHERE id = $1', [orderId]);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
    if (orderRows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Доступ запрещён' });

    const { rows } = await pool.query(
      `INSERT INTO service_tickets (order_id, user_id, user_name, user_email, title, description, images, order_site_type, order_tariff, order_domain, billing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [orderId, req.user.id, req.user.display_name, req.user.email, title, description || null,
        JSON.stringify(images || null), orderSiteType || null, orderTariff || null, orderDomain || null, billing || null]
    );
    res.json(toClient(rows[0]));
  } catch (err) {
    console.error('create service ticket error:', err);
    res.status(500).json({ error: 'Не удалось отправить заявку' });
  }
});

// ── PATCH /api/service-tickets/:id/rate ── оценка (владелец, только для завершённых заявок)
router.patch('/:id/rate', requireAuth, async (req, res) => {
  const { rating } = req.body;
  if (!['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'Некорректная оценка' });
  }
  const { rows } = await pool.query(
    `UPDATE service_tickets SET rating = $1 WHERE id = $2 AND user_id = $3 AND status = 'done' RETURNING *`,
    [rating, req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена или ещё не завершена' });
  res.json(toClient(rows[0]));
});

// ── PATCH /api/service-tickets/:id ── ответ и/или статус (только админ)
router.patch('/:id', requireAdmin, async (req, res) => {
  const { adminReply, status } = req.body;
  const sets = [];
  const values = [];
  let i = 1;
  if (adminReply !== undefined) { sets.push(`admin_reply = $${i++}`); values.push(adminReply); }
  if (status !== undefined) {
    if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
    sets.push(`status = $${i++}`); values.push(status);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE service_tickets SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(toClient(rows[0]));
});

// ── DELETE /api/service-tickets/:id ── удалить заявку (только админ)
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM service_tickets WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json({ ok: true });
});

module.exports = router;
