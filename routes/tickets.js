const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// ── Файловые вложения (pdf, zip, документы офиса, txt/csv). Картинки идут отдельно, через imageUrl.
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 МБ на файл (лимит тела запроса в server.js — 30 МБ)
const ALLOWED_FILE_EXT = ['pdf', 'zip', 'rar', '7z', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'rtf', 'odt', 'ods'];

// Картинки идут строкой data:image/...;base64,... прямо в <img src="..."> у клиента и в админке —
// поэтому пропускаем строго base64 png/jpg/webp/gif, без кавычек и прочих символов (иначе через
// imageUrl можно было бы протащить разметку и выполнить чужой скрипт в админке — stored XSS).
const IMAGE_URL_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
function checkImageUrl(u) {
  if (u == null || u === '') return;
  if (typeof u !== 'string' || u.length > 12000000 || !IMAGE_URL_RE.test(u)) throw new Error('Некорректное изображение (нужен png, jpg, webp или gif)');
}

// Проверяет { name, dataUrl } от клиента и возвращает нормализованный объект или бросает Error с текстом для пользователя.
function parseFile(file) {
  if (!file || typeof file !== 'object') return null;
  const name = String(file.name || '').trim().slice(0, 180);
  const dataUrl = String(file.dataUrl || '');
  const m = /^data:([\w.+\-/]*);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!name || !m) throw new Error('Некорректный файл');
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_FILE_EXT.includes(ext)) throw new Error('Такой тип файла не поддерживается');
  const b64 = m[2].replace(/\s/g, '');
  const size = Math.floor(b64.length * 3 / 4) - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  if (size <= 0) throw new Error('Файл пустой');
  if (size > MAX_FILE_BYTES) throw new Error('Файл больше 8 МБ');
  return { name, mime: m[1] || 'application/octet-stream', size, dataUrl: `data:${m[1] || 'application/octet-stream'};base64,${b64}` };
}

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
    rating: t.rating ?? null,
    ratingComment: t.rating_comment ?? null,
    ratedAt: t.rated_at ?? null,
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
    // Сам файл отдаётся отдельным запросом (GET /:id/messages/:mid/file) — в списке только метаданные
    file: m.file_name ? { name: m.file_name, mime: m.file_mime, size: m.file_size } : null,
    createdAt: m.created_at,
  };
}

// Список сообщений не тянет file_data (base64 может весить мегабайты)
const MESSAGE_COLS = 'id, ticket_id, sender, text, image_url, file_name, file_mime, file_size, created_at';

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
    let file = null;
    try { checkImageUrl(imageUrl); file = parseFile(req.body.file); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!subject || (!message && !imageUrl && !file)) return res.status(400).json({ error: 'Заполните тему и сообщение' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO tickets (user_id, user_name, user_email, topic, priority, subject, order_id, order_label, is_read)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING *`,
      [req.user.id, req.user.display_name, req.user.email, topic || null, priority || null, subject, orderId || null, orderLabel || null]
    );
    const ticket = rows[0];
    await client.query(
      `INSERT INTO ticket_messages (ticket_id, sender, text, image_url, file_name, file_mime, file_size, file_data)
       VALUES ($1, 'user', $2, $3, $4, $5, $6, $7)`,
      [ticket.id, message || null, imageUrl || null, file?.name || null, file?.mime || null, file?.size || null, file?.dataUrl || null]
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
    `SELECT ${MESSAGE_COLS} FROM ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json(rows.map(toClientMessage));
});

// ── POST /api/tickets/:id/messages ── отправить сообщение (владелец или админ)
router.post('/:id/messages', requireAuth, async (req, res) => {
  try {
    const { text, imageUrl, asAdmin } = req.body;
    let file = null;
    try { checkImageUrl(imageUrl); file = parseFile(req.body.file); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (!text && !imageUrl && !file) return res.status(400).json({ error: 'Пустое сообщение' });

    const { rows: tRows } = await pool.query('SELECT * FROM tickets WHERE id = $1', [req.params.id]);
    if (tRows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
    const ticket = tRows[0];
    const isOwner = ticket.user_id === req.user.id;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Доступ запрещён' });

    // ВАЖНО: раньше "кто пишет" определялось по владению тикетом
    // (isAdmin && !isOwner) — это ломалось, если админ отвечал в СВОЙ
    // собственный тикет (например, при тестировании): сообщение подписывалось
    // как 'user', хотя писал именно админ. Теперь клиент явно говорит, с
    // какой страницы пришёл запрос (asAdmin=true шлёт только admin/chats.html),
    // и это имеет приоритет — но подделать это может только тот, у кого
    // реально role='admin' в базе.
    const sender = (asAdmin && isAdmin) ? 'admin' : 'user';
    const { rows } = await pool.query(
      `INSERT INTO ticket_messages (ticket_id, sender, text, image_url, file_name, file_mime, file_size, file_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${MESSAGE_COLS}`,
      [req.params.id, sender, text || null, imageUrl || null, file?.name || null, file?.mime || null, file?.size || null, file?.dataUrl || null]
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
      // ВАЖНО: пуш в Telegram сюда НЕ добавляем — admin/chats.html после
      // отправки сообщения сам дёргает POST /api/notifications/broadcast
      // (функция notifyClient), а тот роут уже отправляет уведомление в
      // Telegram сам. Если продублировать здесь — клиент получит одно и то
      // же сообщение в боте дважды (ровно это и произошло при первой версии).
    } else {
      await pool.query(
        `UPDATE tickets SET updated_at = now(), status = 'open', is_read = TRUE, admin_read = FALSE WHERE id = $1`,
        [req.params.id]
      );
    }

    res.json(toClientMessage(rows[0]));
  } catch (err) {
    console.error('POST /tickets/:id/messages:', err);
    res.status(500).json({ error: 'Не удалось отправить сообщение, попробуйте ещё раз' });
  }
});

// ── GET /api/tickets/:id/messages/:mid/file ── скачать вложение сообщения (владелец или админ)
router.get('/:id/messages/:mid/file', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.file_name, m.file_mime, m.file_data, t.user_id
       FROM ticket_messages m JOIN tickets t ON t.id = m.ticket_id
       WHERE m.id = $1 AND m.ticket_id = $2`,
      [req.params.mid, req.params.id]
    );
    if (rows.length === 0 || !rows[0].file_data) return res.status(404).json({ error: 'Файл не найден' });
    if (rows[0].user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const m = /^data:[^;]*;base64,(.*)$/s.exec(rows[0].file_data);
    if (!m) return res.status(500).json({ error: 'Файл повреждён' });
    const buf = Buffer.from(m[1], 'base64');
    res.setHeader('Content-Type', rows[0].file_mime || 'application/octet-stream');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Всегда как вложение (не открываем в браузере) — защита от XSS через загруженные файлы
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].file_name || 'file')}`);
    res.send(buf);
  } catch (err) {
    console.error('GET /tickets/:id/messages/:mid/file:', err);
    res.status(500).json({ error: 'Не удалось скачать файл' });
  }
});

// ── PATCH /api/tickets/:id/rate ── оценить работу поддержки по закрытому тикету (только владелец)
// Тело: { rating: 1..5, comment?: string }. Оценку можно поменять, пока тикет в статусе 'done'.
router.patch('/:id/rate', requireAuth, async (req, res) => {
  try {
    const rating = Number(req.body?.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Оценка должна быть от 1 до 5' });
    }
    const comment = String(req.body?.comment || '').trim().slice(0, 1000) || null;

    const { rows: tRows } = await pool.query('SELECT user_id, status FROM tickets WHERE id = $1', [req.params.id]);
    if (tRows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
    if (tRows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Доступ запрещён' });
    if (tRows[0].status !== 'done') return res.status(400).json({ error: 'Оценить можно только решённое обращение' });

    const { rows } = await pool.query(
      `UPDATE tickets SET rating = $1, rating_comment = $2, rated_at = now() WHERE id = $3 RETURNING *`,
      [rating, comment, req.params.id]
    );
    res.json(toClientTicket(rows[0]));
  } catch (err) {
    console.error('PATCH /tickets/:id/rate:', err);
    res.status(500).json({ error: 'Не удалось сохранить оценку' });
  }
});

// ── PATCH /api/tickets/:id/read ── отметить прочитанным (владелец)
router.patch('/:id/read', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE tickets SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /tickets/:id/read:', err);
    res.status(500).json({ error: 'Не удалось отметить прочитанным' });
  }
});

// ── PATCH /api/tickets/:id/admin-read ── отметить прочитанным админом
router.patch('/:id/admin-read', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE tickets SET admin_read = TRUE WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
    res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /tickets/:id/admin-read:', err);
    res.status(500).json({ error: 'Не удалось отметить прочитанным' });
  }
});

// ── DELETE /api/tickets/:id ── удалить обращение целиком (только админ)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('DELETE FROM tickets WHERE id = $1 RETURNING id', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Обращение не найдено' });
    res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /tickets/:id:', err);
    res.status(500).json({ error: 'Не удалось удалить обращение' });
  }
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
