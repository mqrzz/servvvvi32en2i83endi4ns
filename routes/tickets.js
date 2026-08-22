const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

function toClientTicket(t) {
  return {
    id: t.id,
    uid: t.user_id,
    userName: t.user_name,
    userEmail: t.user_email,
    topic: t.topic,
    priority: t.priority,
    subject: t.subject,
    orderId: t.order_id,
    orderLabel: t.order_label,
    status: t.status,
    read: t.is_read,
    adminRead: t.admin_read,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

function toClientMessage(m) {
  return {
    id: m.id,
    sender: m.sender,
    text: m.text,
    imageUrl: m.image_url,
    createdAt: m.created_at,
  };
}

// ── GET /api/tickets/admin/all ── все тикеты (только админ) — выше /:id по той же причине, что и в orders.js
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tickets ORDER BY updated_at DESC');
  res.json(rows.map(toClientTicket));
});

// ── GET /api/tickets ── список своих тикетов
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM tickets WHERE user_id = $1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  res.json(rows.map(toClientTicket));
});

// ── POST /api/tickets ── создать тикет + первое сообщение
router.post('/', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    const { topic, priority, subject, message, imageUrl, orderId, orderLabel } = req.body;
    if (!subject || (!message && !imageUrl)) return res.status(400).json({ error: 'Заполните тему и сообщение' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO tickets (user_id, user_name, user_email, topic, priority, subject, order_id, order_label, is_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING *`,
      [req.user.id, req.user.display_name, req.user.email, topic || null, priority || null, subject, orderId || null, orderLabel || null]
    );
    const ticket = rows[0];
    await client.query(
      `INSERT INTO ticket_messages (ticket_id, sender, text, image_url) VALUES ($1, 'user', $2, $3)`,
      [ticket.id, message || null, imageUrl || null]
    );
    await client.query('COMMIT');
    res.json(toClientTicket(ticket));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('create ticket error:', err);
    res.status(500).json({ error: 'Не удалось создать обращение' });
  } finally {
    client.release();
  }
});

// ── GET /api/tickets/:id ── один тикет (владелец или админ)
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  const ticket = rows[0];
  if (ticket.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json(toClientTicket(ticket));
});

// ── GET /api/tickets/:id/messages ── сообщения тикета
router.get('/:id/messages', requireAuth, async (req, res) => {
  const { rows: tRows } = await pool.query('SELECT user_id FROM tickets WHERE id = $1', [req.params.id]);
  if (tRows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  if (tRows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  const { rows } = await pool.query(
    'SELECT * FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC',
    [req.params.id]
  );
  res.json(rows.map(toClientMessage));
});

// ── POST /api/tickets/:id/messages ── отправить сообщение (владелец или админ)
router.post('/:id/messages', requireAuth, async (req, res) => {
  const { text, imageUrl } = req.body;
  if (!text && !imageUrl) return res.status(400).json({ error: 'Пустое сообщение' });

  const { rows: tRows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
  if (tRows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  const ticket = tRows[0];
  const isOwner = ticket.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Доступ запрещён' });

  const sender = isAdmin && !isOwner ? 'admin' : 'user';
  const { rows } = await pool.query(
    `INSERT INTO ticket_messages (ticket_id, sender, text, image_url) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.params.id, sender, text || null, imageUrl || null]
  );

  // Обновляем тикет: время + статус (переоткрываем, если юзер написал в закрытый).
  // is_read = увидел ли КЛИЕНТ последний ответ, admin_read = увидел ли АДМИН
  // последнее сообщение — это два независимых флага, каждый смотрит на
  // "чужую" сторону переписки.
  if (sender === 'admin') {
    await pool.query(
      `UPDATE tickets SET updated_at = now(), status = 'open', is_read = FALSE, admin_read = TRUE WHERE id = $1`,
      [req.params.id]
    );
  } else {
    await pool.query(
      `UPDATE tickets SET updated_at = now(), status = 'open', is_read = TRUE, admin_read = FALSE WHERE id = $1`,
      [req.params.id]
    );
  }

  res.json(toClientMessage(rows[0]));
});

// ── PATCH /api/tickets/:id/read ── отметить прочитанным (владелец)
router.patch('/:id/read', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE tickets SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  res.json({ ok: true });
});

// ── PATCH /api/tickets/:id/admin-read ── отметить прочитанным админом
router.patch('/:id/admin-read', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('UPDATE tickets SET admin_read = TRUE WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  res.json({ ok: true });
});

// ── DELETE /api/tickets/:id ── удалить обращение целиком (только админ)
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM tickets WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  res.json({ ok: true });
});

// ── POST /api/tickets/admin/create ── создать тикет от лица админа (для конкретного юзера)
router.post('/admin/create', requireAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { userId, topic, subject, message, priority } = req.body;
    if (!userId || !subject || !message) return res.status(400).json({ error: 'Заполните обязательные поля' });

    const { rows: userRows } = await client.query('SELECT display_name, email FROM users WHERE id = $1', [userId]);
    if (userRows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    const targetUser = userRows[0];

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO tickets (user_id, user_name, user_email, topic, priority, subject, is_read, admin_read)
       VALUES ($1,$2,$3,$4,$5,$6,FALSE,TRUE) RETURNING *`,
      [userId, targetUser.display_name, targetUser.email, topic || 'Общий вопрос', priority || 'medium', subject]
    );
    const ticket = rows[0];
    await client.query(
      `INSERT INTO ticket_messages (ticket_id, sender, text) VALUES ($1, 'admin', $2)`,
      [ticket.id, message]
    );
    await client.query('COMMIT');
    res.json(toClientTicket(ticket));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('admin create ticket error:', err);
    res.status(500).json({ error: 'Не удалось создать тикет' });
  } finally {
    client.release();
  }
});

// ── PATCH /api/tickets/:id/status ── смена статуса (только админ)
router.patch('/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (!['open', 'done'].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
  const { rows } = await pool.query('UPDATE tickets SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
  res.json(toClientTicket(rows[0]));
});

module.exports = router;
