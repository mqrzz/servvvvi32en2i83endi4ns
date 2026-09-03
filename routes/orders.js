const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin, requireUserOrService } = require('../middleware/requireAuth');
const { sendNewOrderEmail } = require('../utils/mailer');

const router = express.Router();

// Приводим snake_case из БД к camelCase, как ожидает фронт (site*, clientName и т.д.)
function toClientOrder(o) {
  return {
    id: o.id,
    uid: o.user_id,
    orderType: o.order_type || 'site',
    package: o.package,
    siteType: o.site_type,
    siteFormat: o.site_format,
    pages: o.pages,
    totalPrice: Number(o.total_price),
    extras: o.extras,
    domainOption: o.domain_option,
    domainName: o.domain_name,
    promoCode: o.promo_code,
    discountApplied: o.discount_applied ? Number(o.discount_applied) : 0,
    description: o.description,
    goals: o.goals,
    contentReadiness: o.content_readiness,
    referencesText: o.references_text,
    launchDate: o.launch_date,
    shopDetails: o.shop_details,
    attachments: o.attachments,
    favicon: o.favicon_data,
    paymentType: o.payment_type,
    paidAmount: o.paid_amount ? Number(o.paid_amount) : 0,
    remainingAmount: o.remaining_amount ? Number(o.remaining_amount) : 0,
    status: o.status,
    revisionRequested: o.revision_requested,
    reviewed: o.reviewed,
    siteUrl: o.site_url,
    siteDomain: o.site_domain,
    siteFaviconUrl: o.site_favicon_url,
    sitePages: o.site_pages,
    siteRepo: o.site_repo,
    botUsername: o.bot_username,
    botLink: o.bot_link,
    tariff: o.tariff,
    statusComment: o.status_comment,
    startedAt: o.started_at,
    doneAt: o.done_at,
    archived: o.archived,
    paid: o.paid,
    paidAt: o.paid_at,
    lastPaymentAt: o.last_payment_at,
    outSum: o.out_sum ? Number(o.out_sum) : null,
    refundStatus: o.refund_status,
    refundAmount: o.refund_amount ? Number(o.refund_amount) : null,
    refundComment: o.refund_comment,
    refundRequestedAt: o.refund_requested_at,
    refundDecidedAt: o.refund_decided_at,
    refundedAt: o.refunded_at,
    supportActive: o.support_active,
    supportRequested: o.support_requested,
    supportTariff: o.support_tariff,
    supportStartedAt: o.support_started_at,
    supportExpiresAt: o.support_expires_at,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    clientName: o.client_name,
    clientEmail: o.client_email,
  };
}

// Расширенная версия для админки — добавляет внутренние заметки, которые
// НЕ должны попадать клиенту (в отличие от statusComment). Используется
// только в admin-роутах, никогда в клиентских (GET /, GET /:id для владельца).
function toAdminOrder(o) {
  return { ...toClientOrder(o), adminNotes: o.admin_notes || '' };
}

// Пишем запись в историю статусов заказа. changedBy = email админа,
// либо null для системных изменений (напр. вебхук оплаты меняет статус 6→5).
async function logStatusChange(orderId, status, changedBy) {
  try {
    await pool.query(
      `INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1,$2,$3)`,
      [orderId, status, changedBy || null]
    );
  } catch (err) {
    console.error('log status history error:', err);
  }
}

// ── GET /api/orders ── список заказов текущего юзера
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM orders WHERE user_id = $1 AND status != -1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(rows.map(toClientOrder));
});

// ── GET /api/orders/admin/all ── все заказы (только админ)
// ВАЖНО: этот маршрут должен идти раньше /:id, иначе Express примет
// "admin" за значение параметра :id.
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
  res.json(rows.map(toAdminOrder));
});

// ── GET /api/orders/:id ── один заказ (владелец или админ)
router.get('/:id', requireUserOrService, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const order = rows[0];
  const isOwner = order.user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Доступ запрещён' });
  res.json(isAdmin ? toAdminOrder(order) : toClientOrder(order));
});

// ── GET /api/orders/:id/history ── история смены статусов (владелец или админ)
// Владельцу — только статус+дата (для таймлайна в кабинете), админу — ещё и кто менял.
router.get('/:id/history', requireUserOrService, async (req, res) => {
  const { rows: oRows } = await pool.query('SELECT user_id FROM orders WHERE id = $1', [req.params.id]);
  if (oRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const isOwner = oRows[0].user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Доступ запрещён' });

  const { rows } = await pool.query(
    `SELECT status, changed_by, created_at FROM order_status_history WHERE order_id = $1 ORDER BY created_at ASC`,
    [req.params.id]
  );
  res.json(rows.map(r => ({
    status: r.status,
    changedAt: r.created_at,
    ...(isAdmin ? { changedBy: r.changed_by } : {}),
  })));
});

// ── POST /api/orders ── создать заказ (черновик, status=-1 до оплаты)
router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    // Тип заказа — явно от фронта ('bot' для трека Telegram-бот/мини-апп),
    // а не угадывается потом в админке по пустым/заполненным полям.
    const orderType = b.orderType === 'bot' ? 'bot' : 'site';
    const { rows } = await pool.query(
      `INSERT INTO orders (
        user_id, order_type, client_name, client_email, package, site_type, site_format, pages,
        total_price, extras, domain_option, domain_name, promo_code, discount_applied,
        description, goals, content_readiness, references_text, launch_date,
        shop_details, attachments, favicon_data, payment_type, paid_amount, remaining_amount, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      RETURNING *`,
      [
        req.user.id, orderType, req.user.display_name, req.user.email,
        b.package, b.siteType, b.siteFormat, b.pages || null,
        b.totalPrice, JSON.stringify(b.extras || null), b.domainOption || null, b.domainName || null,
        b.promoCode || null, b.discountApplied || 0,
        b.description || null, JSON.stringify(b.goals || null), b.contentReadiness || null,
        b.referencesText || null, b.launchDate || null,
        JSON.stringify(b.shopDetails || null), JSON.stringify(b.attachments || null), b.favicon || null,
        b.paymentType || null, b.paidAmount || 0, b.remainingAmount || 0, -1, // -1 = черновик до оплаты
      ]
    );
    const order = rows[0];
    res.json(toClientOrder(order));
  } catch (err) {
    console.error('create order error:', err);
    res.status(500).json({ error: 'Не удалось создать заказ' });
  }
});

// ── POST /api/orders/cleanup-drafts ── удалить свои зависшие черновики
// (status=-1, старше 10 минут) — чтобы неоплаченные попытки не копились
router.post('/cleanup-drafts', requireAuth, async (req, res) => {
  await pool.query(
    `DELETE FROM orders WHERE user_id = $1 AND status = -1 AND created_at < now() - interval '10 minutes'`,
    [req.user.id]
  );
  res.json({ ok: true });
});

// ── DELETE /api/orders/:id ── удалить свой черновик (только status=-1, например если оплата не запустилась)
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `DELETE FROM orders WHERE id = $1 AND user_id = $2 AND status = -1 RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Черновик не найден' });
  res.json({ ok: true });
});

// ── PATCH /api/orders/:id ── гибкое обновление любых полей (только админ) —
// используется админкой для статус-комментариев, дат, доставки сайта,
// возвратов, обслуживания и т.д. Белый список полей защищает от
// произвольной записи в колонки, которых нет в этом списке.
const ADMIN_PATCHABLE_FIELDS = {
  orderType: 'order_type', adminNotes: 'admin_notes',
  siteUrl: 'site_url', siteDomain: 'site_domain', siteFaviconUrl: 'site_favicon_url',
  sitePages: 'site_pages', siteRepo: 'site_repo', botUsername: 'bot_username', botLink: 'bot_link',
  tariff: 'tariff', statusComment: 'status_comment', startedAt: 'started_at', doneAt: 'done_at',
  archived: 'archived', paid: 'paid', paidAt: 'paid_at', status: 'status',
  revisionRequested: 'revision_requested', reviewed: 'reviewed',
  refundStatus: 'refund_status', refundAmount: 'refund_amount', refundComment: 'refund_comment',
  refundRequestedAt: 'refund_requested_at', refundDecidedAt: 'refund_decided_at', refundedAt: 'refunded_at',
  supportActive: 'support_active', supportRequested: 'support_requested', supportTariff: 'support_tariff',
  supportStartedAt: 'support_started_at', supportExpiresAt: 'support_expires_at',
};

router.patch('/:id', requireAdmin, async (req, res) => {
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, column] of Object.entries(ADMIN_PATCHABLE_FIELDS)) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) {
      sets.push(`${column} = $${i++}`);
      values.push(req.body[key]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  values.push(req.params.id);

  try {
    const { rows } = await pool.query(`UPDATE orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
    if (rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
    const order = rows[0];

    if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
      logStatusChange(order.id, order.status, req.user.email);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'status') && req.body.status === 0) {
      sendNewOrderEmail(order.client_email, {
        orderId: order.id, packageName: order.package, totalPrice: order.total_price,
      }).catch((e) => console.error('Не удалось отправить письмо о заказе:', e));
    }

    res.json(toAdminOrder(order));
  } catch (err) {
    console.error('admin patch order error:', err);
    res.status(500).json({ error: 'Не удалось обновить заказ' });
  }
});

// ── PATCH /api/orders/:id/status ── смена статуса (только админ)
router.patch('/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (typeof status !== 'number') return res.status(400).json({ error: 'Некорректный статус' });

  const { rows } = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const order = rows[0];
  logStatusChange(order.id, status, req.user.email);

  // Уведомление на почту при переходе в оплаченный статус (0 = принят в работу)
  if (status === 0) {
    sendNewOrderEmail(order.client_email, {
      orderId: order.id,
      packageName: order.package,
      totalPrice: order.total_price,
    }).catch((e) => console.error('Не удалось отправить письмо о заказе:', e));
  }

  res.json(toAdminOrder(order));
});

// ── GET /api/orders/:id/payments ── история платежей по заказу (владелец или админ)
router.get('/:id/payments', requireUserOrService, async (req, res) => {
  const { rows: oRows } = await pool.query('SELECT user_id FROM orders WHERE id = $1', [req.params.id]);
  if (oRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const isOwner = oRows[0].user_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Доступ запрещён' });

  const { rows } = await pool.query(
    `SELECT payment_id, type, amount, created_at FROM payment_events WHERE order_id = $1 ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows.map(r => ({
    paymentId: r.payment_id, type: r.type, amount: Number(r.amount), createdAt: r.created_at,
  })));
});

module.exports = router;
module.exports.toClientOrder = toClientOrder;
module.exports.toAdminOrder = toAdminOrder;
module.exports.logStatusChange = logStatusChange;
