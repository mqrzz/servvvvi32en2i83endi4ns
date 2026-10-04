const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireUserOrService } = require('../middleware/requireAuth');
const { sendNewOrderEmail } = require('../utils/mailer');
const { logStatusChange } = require('./orders');
const { grantOrRenewSubscription } = require('../utils/subscriptions');

const router = express.Router();

const RECENT_WINDOW_MS = 10 * 60 * 1000;

function requireWebhookSecret(req, res, next) {
  const secret = req.headers['x-payment-secret'];
  if (!secret || secret !== process.env.PAYMENT_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Недействительный секрет' });
  }
  next();
}

router.post('/webhook', requireWebhookSecret, async (req, res) => {
  const client = await pool.connect();
  try {
    const { paymentId, orderId, ticketId, type, amount, supportTariff } = req.body;
    if (!paymentId || !orderId || !type || amount == null) {
      return res.status(400).json({ error: 'Неполные данные' });
    }
    const pType = ['support', 'partial', 'remaining', 'ticket_once'].includes(type) ? type : 'order';
    const outSum = Number(amount) || 0;

    await client.query('BEGIN');

    const claim = await client.query(
      `INSERT INTO payment_events (payment_id, order_id, ticket_id, type, amount) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (payment_id) DO NOTHING RETURNING payment_id`,
      [paymentId, orderId, ticketId || null, pType, outSum]
    );
    if (claim.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(200).json({ ok: true, duplicate: true });
    }

    const { rows: orderRows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (orderRows.length === 0) {
      await client.query('COMMIT');
      return res.status(200).json({ ok: true, warning: 'order not found' });
    }
    const order = orderRows[0];
    const now = new Date();

    if (pType === 'support') {
      const tariffKey = ['basic', 'priority'].includes(supportTariff) ? supportTariff : 'basic';

      const { periodEnd } = await grantOrRenewSubscription(client, {
        orderId, userId: order.user_id, tariff: tariffKey, amount: outSum, now,
      });

      await client.query(
        `UPDATE orders SET support_active=TRUE, support_started_at=COALESCE(support_started_at,$1),
         support_expires_at=$2, support_tariff=$3, support_requested=FALSE,
         last_payment_at=$1, out_sum=$4 WHERE id=$5`,
        [now.toISOString(), periodEnd.toISOString(), tariffKey, outSum, orderId]
      );
    } else if (pType === 'ticket_once') {
      if (ticketId) {
        await client.query(
          `UPDATE service_tickets SET paid=TRUE, status='open', paid_at=$1 WHERE id=$2`,
          [now.toISOString(), ticketId]
        );
      }
    } else if (pType === 'partial') {
      const total = Number(order.total_price) || outSum;
      const remaining = Math.max(0, total - outSum);
      await client.query(
        `UPDATE orders SET total_price=$1, paid_amount=$2, remaining_amount=$3, paid_at=$4,
         last_payment_at=$4, out_sum=$2, status = CASE WHEN status = -1 THEN 0 ELSE status END
         WHERE id=$5`,
        [total, outSum, remaining, now.toISOString(), orderId]
      );
      if (order.status === -1 && order.client_email) {
        sendNewOrderEmail(order.client_email, {
          orderId: order.id, packageName: order.package, totalPrice: total, paymentId,
        }).catch((e) => console.error('Не удалось отправить письмо о заказе (partial):', e));
      }
      if (order.status === -1 && order.promo_code) {
        await client.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)`, [order.promo_code]);
      }
      if (order.status === -1) logStatusChange(orderId, 0, null);
    } else if (pType === 'remaining') {
      const totalPaid = Number(order.paid_amount || 0) + outSum;
      await client.query(
        `UPDATE orders SET paid=TRUE, paid_amount=$1, remaining_amount=0, paid_at=$2,
         last_payment_at=$2, out_sum=$3,
         status = CASE WHEN status = 6 THEN 5 ELSE status END,
         done_at = CASE WHEN status = 6 THEN $2 ELSE done_at END
         WHERE id=$4`,
        [totalPaid, now.toISOString(), outSum, orderId]
      );
      if (order.status === 6) logStatusChange(orderId, 5, null);
    } else {
      const total = Number(order.total_price) || outSum;
      await client.query(
        `UPDATE orders SET total_price=$1, paid=TRUE, paid_amount=$1, remaining_amount=0, paid_at=$2,
         last_payment_at=$2, out_sum=$3, status = CASE WHEN status = -1 THEN 0 ELSE status END
         WHERE id=$4`,
        [total, now.toISOString(), outSum, orderId]
      );
      if (order.status === -1 && order.client_email) {
        sendNewOrderEmail(order.client_email, {
          orderId: order.id, packageName: order.package, totalPrice: total, paymentId,
        }).catch((e) => console.error('Не удалось отправить письмо о заказе:', e));
      }
      if (order.status === -1 && order.promo_code) {
        await client.query(`UPDATE promo_codes SET used_count = used_count + 1 WHERE UPPER(code) = UPPER($1)`, [order.promo_code]);
      }
      if (order.status === -1) logStatusChange(orderId, 0, null);
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('payment webhook error:', err);
    res.status(500).json({ error: 'Не удалось применить платёж' });
  } finally {
    client.release();
  }
});

router.get('/mine', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.payment_id, p.type, p.amount, p.created_at, p.order_id, p.ticket_id,
              o.site_domain, o.package, o.order_type
       FROM payment_events p
       JOIN orders o ON o.id = p.order_id
       WHERE o.user_id = $1
       ORDER BY p.created_at DESC
       LIMIT 500`,
      [req.user.id]
    );
    res.json(rows.map((r) => ({
      paymentId: r.payment_id,
      type: r.type,
      amount: Number(r.amount),
      createdAt: r.created_at,
      orderId: r.order_id,
      ticketId: r.ticket_id,
      orderDomain: r.site_domain,
      orderPackage: r.package,
      orderType: r.order_type,
    })));
  } catch (err) {
    console.error('GET /payments/mine:', err);
    res.status(500).json({ error: 'Не удалось загрузить платежи' });
  }
});

router.post('/check', requireUserOrService, async (req, res) => {
  const { orderId, type, ticketId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId обязателен' });
  const pType = ['support', 'partial', 'remaining', 'ticket_once'].includes(type) ? type : 'order';

  const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const order = orderRows[0];
  if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Не ваш заказ' });

  function isRecent(d) { return !!d && (Date.now() - new Date(d).getTime()) < RECENT_WINDOW_MS; }

  async function latestPaymentId(ticketFilter) {
    const { rows } = await pool.query(
      ticketFilter
        ? `SELECT payment_id FROM payment_events WHERE order_id = $1 AND ticket_id = $2 ORDER BY created_at DESC LIMIT 1`
        : `SELECT payment_id FROM payment_events WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      ticketFilter ? [orderId, ticketFilter] : [orderId]
    );
    return rows[0]?.payment_id || null;
  }

  if (pType === 'ticket_once') {
    if (!ticketId) return res.status(400).json({ error: 'ticketId обязателен' });
    const { rows: tRows } = await pool.query('SELECT * FROM service_tickets WHERE id = $1', [ticketId]);
    if (tRows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
    const ticket = tRows[0];
    if (ticket.user_id !== req.user.id || ticket.order_id !== orderId) return res.status(403).json({ error: 'Не ваша заявка' });
    return res.json({ paid: !!ticket.paid, amount: 350, paidAt: ticket.paid_at, paymentId: await latestPaymentId(ticketId) });
  }

  if (pType === 'support') {
    const paid = !!order.support_active && isRecent(order.last_payment_at);
    return res.json({ paid, amount: order.out_sum ? Number(order.out_sum) : null, paidAt: order.last_payment_at, paymentId: paid ? await latestPaymentId() : null });
  }

  const paid = isRecent(order.last_payment_at) && (pType === 'partial' ? Number(order.paid_amount || 0) > 0 : !!order.paid);
  res.json({
    paid,
    amount: paid ? Number(order.out_sum || order.paid_amount || 0) : null,
    paidAt: order.last_payment_at,
    paymentId: paid ? await latestPaymentId() : null,
  });
});

module.exports = router;
