const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { sendNewOrderEmail } = require('../utils/mailer');

const router = express.Router();

// Приводим snake_case из БД к camelCase, как ожидает фронт (site*, clientName и т.д.)
function toClientOrder(o) {
  return {
    id: o.id,
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
    paymentType: o.payment_type,
    status: o.status,
    revisionRequested: o.revision_requested,
    reviewed: o.reviewed,
    siteUrl: o.site_url,
    siteDomain: o.site_domain,
    tariff: o.tariff,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
    clientName: o.client_name,
    clientEmail: o.client_email,
  };
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
  res.json(rows.map(toClientOrder));
});

// ── GET /api/orders/:id ── один заказ (владелец или админ)
router.get('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const order = rows[0];
  if (order.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  res.json(toClientOrder(order));
});

// ── POST /api/orders ── создать заказ (сама форма заказа переедет отдельным этапом,
// этот эндпоинт уже готов принять данные в правильном формате)
router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO orders (
        user_id, client_name, client_email, package, site_type, site_format, pages,
        total_price, extras, domain_option, domain_name, promo_code, discount_applied,
        description, goals, content_readiness, references_text, launch_date,
        shop_details, payment_type, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [
        req.user.id, req.user.display_name, req.user.email,
        b.package, b.siteType, b.siteFormat, b.pages || null,
        b.totalPrice, JSON.stringify(b.extras || null), b.domainOption || null, b.domainName || null,
        b.promoCode || null, b.discountApplied || 0,
        b.description || null, JSON.stringify(b.goals || null), b.contentReadiness || null,
        b.referencesText || null, b.launchDate || null,
        JSON.stringify(b.shopDetails || null), b.paymentType || null, -1, // -1 = черновик до оплаты
      ]
    );
    const order = rows[0];
    res.json(toClientOrder(order));
  } catch (err) {
    console.error('create order error:', err);
    res.status(500).json({ error: 'Не удалось создать заказ' });
  }
});

// ── PATCH /api/orders/:id/status ── смена статуса (только админ)
router.patch('/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  if (typeof status !== 'number') return res.status(400).json({ error: 'Некорректный статус' });

  const { rows } = await pool.query('UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const order = rows[0];

  // Уведомление на почту при переходе в оплаченный статус (0 = принят в работу)
  if (status === 0) {
    sendNewOrderEmail(order.client_email, {
      orderId: order.id,
      packageName: order.package,
      totalPrice: order.total_price,
    }).catch((e) => console.error('Не удалось отправить письмо о заказе:', e));
  }

  res.json(toClientOrder(order));
});

module.exports = router;
