const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');
const { transporter, wrapEmail, baseAttachments } = require('../utils/mailer');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Общий лимит на суммарный объём вложений в одном письме — тот же порядок
// величин, что и у order/index.html (30mb на весь JSON-body), но с запасом
// под заголовки/остальные поля письма.
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`inbound-email.js ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: 'Внутренняя ошибка' });
  });
}

// ── Секрет для вебхука Cloudflare Email Worker'а ──
// Та же схема, что уже используется для бота (X-Bot-Secret) и ЮKassa
// (X-Payment-Secret) — сервер-сервер запрос без пользовательской сессии.
function requireInboundSecret(req, res, next) {
  const secret = req.headers['x-inbound-secret'];
  if (!secret || secret !== process.env.INBOUND_EMAIL_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function attachmentsSize(list) {
  if (!Array.isArray(list)) return 0;
  return list.reduce((sum, a) => sum + Math.ceil(((a && a.data) || '').length * 0.75), 0);
}

// Лёгкая версия для списка сообщений треда: БЕЗ base64 в attachments[].data.
// Раньше GET /threads/:key отдавал ответ через toClientEmail(), который включал
// attachments целиком (вложения хранятся в БД как base64 data URL, до 20 МБ на письмо) —
// для контакта с длинной перепиской и парой скриншотов это были сотни мегабайт JSON
// за один открытие треда: вкладка зависала, скроллить и читать было невозможно.
// Теперь тут только метаданные, сами байты отдаёт отдельный эндпоинт ниже.
function toClientEmailLight(e) {
  return {
    id: e.id,
    direction: e.direction,
    threadKey: e.thread_key,
    messageId: e.message_id,
    inReplyTo: e.in_reply_to,
    fromEmail: e.from_email,
    fromName: e.from_name,
    toEmail: e.to_email,
    subject: e.subject,
    bodyHtml: e.body_html,
    bodyText: e.body_text,
    attachments: (e.attachments || []).map((a, i) => ({ index: i, name: a.name, type: a.type, size: a.size })),
    adminId: e.admin_id,
    templateId: e.template_id,
    isRead: e.is_read,
    createdAt: e.created_at,
  };
}

function toClientEmail(e) {
  return {
    id: e.id,
    direction: e.direction,
    threadKey: e.thread_key,
    messageId: e.message_id,
    inReplyTo: e.in_reply_to,
    fromEmail: e.from_email,
    fromName: e.from_name,
    toEmail: e.to_email,
    subject: e.subject,
    bodyHtml: e.body_html,
    bodyText: e.body_text,
    attachments: e.attachments || [],
    adminId: e.admin_id,
    templateId: e.template_id,
    isRead: e.is_read,
    createdAt: e.created_at,
  };
}

// ── POST /api/inbound-email ── вебхук от Cloudflare Email Worker'а ──
// Форвардинг support@antviz.ru на личную почту в Cloudflare Email Routing
// остаётся отдельным, независимым действием того же правила — сюда прилетает
// копия письма вторым действием ("Send to a Worker"), ничего не меняя в старом канале.
router.post('/', requireInboundSecret, wrap(async (req, res) => {
  const b = req.body || {};
  const fromEmail = String(b.fromEmail || '').trim().toLowerCase();
  if (!fromEmail || !EMAIL_RE.test(fromEmail)) {
    return res.status(400).json({ error: 'Некорректный fromEmail' });
  }
  const attachments = Array.isArray(b.attachments) ? b.attachments : [];
  if (attachmentsSize(attachments) > MAX_ATTACHMENTS_BYTES) {
    return res.status(413).json({ error: 'Вложения слишком большие' });
  }

  const { rows } = await pool.query(
    `INSERT INTO support_emails (
      direction, thread_key, message_id, in_reply_to, from_email, from_name,
      to_email, subject, body_html, body_text, attachments, is_read
    ) VALUES ('in',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false)
    RETURNING *`,
    [
      fromEmail, b.messageId || null, b.inReplyTo || null, fromEmail, b.fromName || null,
      b.toEmail || 'support@antviz.ru', (b.subject || '(без темы)').slice(0, 500),
      b.bodyHtml || null, b.bodyText || null, JSON.stringify(attachments),
    ]
  );

  res.json({ ok: true, id: rows[0].id });
}));

// ── GET /api/inbound-email/threads ── список тредов для списка в админке ──
router.get('/threads', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(`
    SELECT
      thread_key,
      (array_agg(subject ORDER BY created_at DESC))[1] AS last_subject,
      (array_agg(COALESCE(from_name, from_email) ORDER BY created_at DESC) FILTER (WHERE direction = 'in'))[1] AS contact_name,
      (array_agg(CASE WHEN direction = 'in' THEN from_email ELSE to_email END ORDER BY created_at DESC))[1] AS contact_email,
      (array_agg(direction ORDER BY created_at DESC))[1] AS last_direction,
      (array_agg(COALESCE(body_text, subject) ORDER BY created_at DESC))[1] AS preview,
      MAX(created_at) AS last_at,
      COUNT(*) FILTER (WHERE direction = 'in' AND is_read = false)::int AS unread_count
    FROM support_emails
    GROUP BY thread_key
    ORDER BY last_at DESC
  `);
  res.json(rows.map((t) => ({
    threadKey: t.thread_key,
    lastSubject: t.last_subject,
    contactName: t.contact_name,
    contactEmail: t.contact_email,
    lastDirection: t.last_direction,
    preview: (t.preview || '').slice(0, 160),
    lastAt: t.last_at,
    unreadCount: t.unread_count,
  })));
}));

// ── GET /api/inbound-email/threads/:key ── вся переписка треда, помечает входящие прочитанными ──
router.get('/threads/:key', requireAdmin, wrap(async (req, res) => {
  const key = req.params.key.toLowerCase();
  // limit/before — курсорная пагинация по created_at (страница за страницей, от новых к старым).
  // Без неё контакт с длинной перепиской отдавал всю историю одним запросом — см. toClientEmailLight выше.
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const before = req.query.before || null;

  const params = [key];
  let where = 'thread_key = $1';
  if (before) { params.push(before); where += ` AND created_at < $${params.length}`; }
  params.push(limit + 1); // +1 — чтобы понять, есть ли ещё более старые письма, не делая отдельный COUNT

  const { rows } = await pool.query(
    `SELECT * FROM support_emails WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse(); // обратно в хронологический порядок для рендера

  // Читаем весь тред целиком (не только показанную страницу) — открыл тред, значит увидел все непрочитанные,
  // даже если старые письма ещё не подгружены кнопкой «показать более старые».
  pool.query(
    "UPDATE support_emails SET is_read = true WHERE thread_key = $1 AND direction = 'in' AND is_read = false",
    [key]
  ).catch((e) => console.error('mark thread read:', e));

  res.json({ messages: page.map(toClientEmailLight), hasMore });
}));

// ── GET /api/inbound-email/threads/:key/messages/:id/attachments/:index ── байты одного вложения ──
// Вместо base64 внутри общего списка писем (см. выше) — отдаём по требованию, как файлы в тикетах поддержки.
router.get('/threads/:key/messages/:id/attachments/:index', requireAdmin, wrap(async (req, res) => {
  const key = req.params.key.toLowerCase();
  const { rows } = await pool.query(
    'SELECT thread_key, attachments FROM support_emails WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0 || rows[0].thread_key !== key) return res.status(404).json({ error: 'Письмо не найдено' });
  const att = (rows[0].attachments || [])[Number(req.params.index)];
  if (!att || !att.data) return res.status(404).json({ error: 'Вложение не найдено' });
  const m = /^data:([^;]*);base64,(.*)$/s.exec(att.data);
  if (!m) return res.status(500).json({ error: 'Вложение повреждено' });
  const buf = Buffer.from(m[2], 'base64');
  const mime = m[1] || att.type || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', buf.length);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const disposition = /^image\//.test(mime) ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(att.name || 'file')}`);
  res.send(buf);
}));

// ── DELETE /api/inbound-email/threads/:key ── удалить всю переписку с адресом ──
router.delete('/threads/:key', requireAdmin, wrap(async (req, res) => {
  const key = req.params.key.toLowerCase();
  await pool.query('DELETE FROM support_emails WHERE thread_key = $1', [key]);
  res.json({ ok: true });
}));

function buildAttachmentsForSend(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => {
    const match = /^data:([^;]+);base64,(.+)$/.exec(a.data || '');
    return {
      filename: a.name || 'file',
      content: Buffer.from(match ? match[2] : a.data || '', 'base64'),
      contentType: match ? match[1] : a.type || undefined,
    };
  });
}

// ── POST /api/inbound-email/threads/:key/reply ── ответ в существующий тред ──
router.post('/threads/:key/reply', requireAdmin, wrap(async (req, res) => {
  const key = req.params.key.toLowerCase();
  const b = req.body || {};
  const subject = (b.subject || '').trim();
  const bodyHtml = b.bodyHtml || '';
  if (!bodyHtml.trim() && !(b.bodyText || '').trim()) {
    return res.status(400).json({ error: 'Пустое письмо' });
  }
  const attachments = Array.isArray(b.attachments) ? b.attachments : [];
  if (attachmentsSize(attachments) > MAX_ATTACHMENTS_BYTES) {
    return res.status(413).json({ error: 'Вложения слишком большие (макс. ~20 МБ)' });
  }

  // Последнее входящее письмо треда — чтобы ответ склеился в тот же тред
  // у получателя (In-Reply-To/References) и чтобы знать, куда слать, если
  // toEmail явно не передан.
  const { rows: lastInRows } = await pool.query(
    "SELECT * FROM support_emails WHERE thread_key = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1",
    [key]
  );
  const lastIn = lastInRows[0];
  const toEmail = (b.toEmail || (lastIn && lastIn.from_email) || key).trim();
  if (!EMAIL_RE.test(toEmail)) return res.status(400).json({ error: 'Некорректный получатель' });

  const fromAddr = process.env.SUPPORT_MAIL_FROM || process.env.MAIL_FROM;
  const sendSubject = subject || `Re: ${(lastIn && lastIn.subject) || ''}`.trim();
  const info = await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject: sendSubject,
    // Фирменный каркас (лого, соцсети, футер) — тот же, что и у остальных писем
    // Antviz. В базе/на экране админки хранится и показывается обычный
    // bodyHtml без брендинга (ниже, в INSERT) — обёртка нужна только на отправке.
    html: wrapEmail({ heading: sendSubject || 'Ответ от Antviz', bodyHtml: bodyHtml || (b.bodyText || '').replace(/\n/g, '<br/>') }),
    text: b.bodyText || undefined,
    attachments: [...baseAttachments(), ...buildAttachmentsForSend(attachments)],
    inReplyTo: lastIn && lastIn.message_id ? lastIn.message_id : undefined,
    references: lastIn && lastIn.message_id ? lastIn.message_id : undefined,
  });

  const { rows } = await pool.query(
    `INSERT INTO support_emails (
      direction, thread_key, message_id, in_reply_to, from_email, from_name,
      to_email, subject, body_html, body_text, attachments, admin_id, template_id, is_read
    ) VALUES ('out',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
    RETURNING *`,
    [
      key, info.messageId || null, lastIn ? lastIn.message_id : null, fromAddr, null,
      toEmail, sendSubject,
      bodyHtml || null, b.bodyText || null, JSON.stringify(attachments),
      req.user.id, b.templateId || null,
    ]
  );

  res.json(toClientEmail(rows[0]));
}));

// ── POST /api/inbound-email/compose ── новое письмо (не ответ на существующий тред) ──
router.post('/compose', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const toEmail = (b.toEmail || '').trim().toLowerCase();
  if (!toEmail || !EMAIL_RE.test(toEmail)) return res.status(400).json({ error: 'Некорректный email получателя' });
  const subject = (b.subject || '').trim();
  const bodyHtml = b.bodyHtml || '';
  if (!subject) return res.status(400).json({ error: 'Укажите тему письма' });
  if (!bodyHtml.trim() && !(b.bodyText || '').trim()) return res.status(400).json({ error: 'Пустое письмо' });

  const attachments = Array.isArray(b.attachments) ? b.attachments : [];
  if (attachmentsSize(attachments) > MAX_ATTACHMENTS_BYTES) {
    return res.status(413).json({ error: 'Вложения слишком большие (макс. ~20 МБ)' });
  }

  const fromAddr = process.env.SUPPORT_MAIL_FROM || process.env.MAIL_FROM;
  const info = await transporter.sendMail({
    from: fromAddr,
    to: toEmail,
    subject,
    html: wrapEmail({ heading: subject, bodyHtml: bodyHtml || (b.bodyText || '').replace(/\n/g, '<br/>') }),
    text: b.bodyText || undefined,
    attachments: [...baseAttachments(), ...buildAttachmentsForSend(attachments)],
  });

  const { rows } = await pool.query(
    `INSERT INTO support_emails (
      direction, thread_key, message_id, from_email, to_email, subject,
      body_html, body_text, attachments, admin_id, template_id, is_read
    ) VALUES ('out',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
    RETURNING *`,
    [
      toEmail, info.messageId || null, fromAddr, toEmail, subject,
      bodyHtml || null, b.bodyText || null, JSON.stringify(attachments),
      req.user.id, b.templateId || null,
    ]
  );

  res.json(toClientEmail(rows[0]));
}));

module.exports = router;
