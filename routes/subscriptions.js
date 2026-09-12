const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');
const { SUPPORT_TARIFFS, DEFAULT_SUPPORT_TARIFF } = require('../utils/pricing');
const { grantOrRenewSubscription } = require('../utils/subscriptions');

const router = express.Router();

function toClient(s) {
  if (!s) return null;
  const limit = (SUPPORT_TARIFFS[s.tariff] || SUPPORT_TARIFFS[DEFAULT_SUPPORT_TARIFF]).limit;
  const periodEnd = new Date(s.period_end);
  const daysLeft = Math.max(0, Math.ceil((periodEnd - new Date()) / (24 * 60 * 60 * 1000)));
  return {
    id: s.id,
    orderId: s.order_id,
    tariff: s.tariff,
    status: s.status,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    ticketsUsed: s.tickets_used,
    ticketsLimit: limit,
    daysLeft,
    isExpiringSoon: s.status === 'active' && daysLeft <= 3,
    autoRenew: s.auto_renew,
  };
}

// ── GET /api/subscriptions/:orderId ── подписка на конкретный заказ
// (или null, если её никогда не оформляли) — источник истины для
// profile/tickets.html вместо подсчёта "сколько заявок в этом месяце"
// на клиенте по списку тикетов.
router.get('/:orderId', requireAuth, async (req, res) => {
  const { rows: orderRows } = await pool.query('SELECT user_id FROM orders WHERE id = $1', [req.params.orderId]);
  if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  if (orderRows[0].user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ запрещён' });
  }
  const { rows } = await pool.query(
    'SELECT * FROM service_subscriptions WHERE order_id = $1',
    [req.params.orderId]
  );
  res.json(toClient(rows[0] || null));
});

// ── PATCH /api/subscriptions/:orderId/auto-renew ── включить/выключить автопродление
router.patch('/:orderId/auto-renew', requireAuth, async (req, res) => {
  const { enabled } = req.body;
  const { rows: orderRows } = await pool.query('SELECT user_id FROM orders WHERE id = $1', [req.params.orderId]);
  if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  if (orderRows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Доступ запрещён' });
  const { rows } = await pool.query(
    `UPDATE service_subscriptions SET auto_renew = $1 WHERE order_id = $2 AND status = 'active' RETURNING *`,
    [!!enabled, req.params.orderId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Активная подписка не найдена' });
  res.json(toClient(rows[0]));
});

// ── POST /api/subscriptions/:orderId/admin-grant ── ручная выдача/продление
// админом (кнопки "Активировать"/"Продлить" в admin/orders.html). Раньше
// эти кнопки писали напрямую в orders.support_active/support_expires_at
// мимо всей остальной системы — после перехода лимита заявок на
// service_subscriptions такая "активация" переставала реально работать:
// клиенту показывалось "подключено", а сервер при создании заявки всё
// равно требовал оплату, потому что настоящей подписки не было. Теперь
// использует тот же helper, что и оплата (utils/subscriptions.js), только
// с amount=0 — в истории продлений это видно как комплиментарную выдачу.
router.post('/:orderId/admin-grant', requireAdmin, async (req, res) => {
  const { tariff } = req.body || {};
  if (tariff && !SUPPORT_TARIFFS[tariff]) return res.status(400).json({ error: 'Неизвестный тариф' });
  const client = await pool.connect();
  try {
    const { rows: orderRows } = await client.query('SELECT user_id FROM orders WHERE id = $1', [req.params.orderId]);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

    await client.query('BEGIN');
    const { periodEnd, tariff: usedTariff } = await grantOrRenewSubscription(client, {
      orderId: req.params.orderId,
      userId: orderRows[0].user_id,
      tariff: tariff || null,
      amount: 0,
      now: new Date(),
    });
    // Синхронизируем кэш на orders.support_* — админка сейчас читает его
    // напрямую для отображения (renderSupport в admin/orders.html).
    await client.query(
      `UPDATE orders SET support_active=TRUE, support_started_at=COALESCE(support_started_at, now()),
       support_expires_at=$1, support_tariff=$2, support_requested=FALSE WHERE id=$3`,
      [periodEnd.toISOString(), usedTariff, req.params.orderId]
    );
    await client.query('COMMIT');

    const { rows } = await pool.query('SELECT * FROM service_subscriptions WHERE order_id = $1', [req.params.orderId]);
    res.json(toClient(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('admin-grant subscription error:', err);
    res.status(500).json({ error: 'Не удалось выдать обслуживание' });
  } finally {
    client.release();
  }
});

module.exports = router;
