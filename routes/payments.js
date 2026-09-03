const express = require('express');
const pool = require('../db/pool');
const { requireUserOrService } = require('../middleware/requireAuth');
const { sendNewOrderEmail } = require('../utils/mailer');
const { logStatusChange } = require('./orders');

const router = express.Router();

// Окно, в течение которого последний платёж считается "недавним" для /check
// (страница payment_success опрашивает этот роут сразу после возврата с оплаты).
const RECENT_WINDOW_MS = 10 * 60 * 1000;

const TIER_PRICES = {
  'Старт': 2900, 'Рост': 5900, 'Масштаб': 11900,
  'Простой бот': 4900, 'Бот с оплатой': 9900, 'Mini App': 16900,
};
const EXTRA_PRICES = { content: 2000, shop: 4900, bot_pay: 3000, bot_crm: 2500 };

// Пересчитываем сумму заказа заново на момент оплаты (а не доверяем
// total_price, сохранённому клиентом при оформлении) — если промокод к
// этому моменту истёк/деактивирован/не для этого юзера, скидка больше не
// применяется. Без этого клиент мог бы оформить заказ с ещё живым
// промокодом, потом дождаться его окончания и всё равно доплатить по
// сниженной цене, посчитанной в момент создания заказа.
async function recalcOrderTotal(client, order) {
  const base = TIER_PRICES[order.package];
  if (base == null) return Number(order.total_price); // неизвестный тариф — не пересчитываем
  let running = base;
  const extras = Array.isArray(order.extras) ? order.extras : [];
  for (const key of Object.keys(EXTRA_PRICES)) if (extras.includes(key)) running += EXTRA_PRICES[key];
  if (extras.includes('urgent')) running += Math.round(running * 0.3);

  let discount = 0;
  if (order.promo_code) {
    const { rows } = await client.query(
      `SELECT * FROM promo_codes WHERE UPPER(code) = UPPER($1) AND active = TRUE`,
      [order.promo_code]
    );
    if (rows.length) {
      const p = rows[0];
      const expired = p.expires_at && new Date(p.expires_at) < new Date();
      const wrongUser = p.for_user_id && p.for_user_id !== order.user_id;
      if (!expired && !wrongUser) {
        discount = p.discount_type === 'percent'
          ? Math.round(running * p.discount_value / 100)
          : Math.min(Number(p.discount_value), running);
      }
    }
  }
  return Math.max(0, running - discount);
}

// Простой машинный секрет: вебхук вызывает наш собственный Vercel-код
// (resultUrl.js), не браузер — там нет "текущего юзера" вообще (ЮКасса
// стучится напрямую в Vercel, а Vercel — сюда). Поэтому доверие не через
// JWT пользователя, а через общий секрет в заголовке, известный только
// нашему серверу и той Vercel-функции.
function requireWebhookSecret(req, res, next) {
  const secret = req.headers['x-payment-secret'];
  if (!secret || secret !== process.env.PAYMENT_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Недействительный секрет' });
  }
  next();
}

// ── POST /api/payments/webhook ── применяет результат успешного платежа.
// Вызывается ТОЛЬКО из resultUrl.js на Vercel, который сам уже сверил
// статус платежа напрямую с ЮКассой (тут мы этому вызову доверяем).
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

    // Идемпотентность: если этот paymentId уже обработан — это точно
    // повторная доставка вебхука от ЮКассы, применять второй раз нельзя
    // (иначе деньги задвоятся в базе, хотя реальная оплата была одна).
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
      await client.query('COMMIT'); // claim уже записан — не переигрываем, просто отмечаем
      return res.status(200).json({ ok: true, warning: 'order not found' });
    }
    const order = orderRows[0];
    const now = new Date();

    if (pType === 'support') {
      const tariffKey = ['basic', 'priority'].includes(supportTariff) ? supportTariff : 'basic';
      const currentExpiry = order.support_expires_at ? new Date(order.support_expires_at) : null;
      const base = currentExpiry && currentExpiry > now ? currentExpiry : now;
      const newExpiry = new Date(base.getTime() + 30 * 24 * 60 * 60 * 1000);
      await client.query(
        `UPDATE orders SET support_active=TRUE, support_started_at=COALESCE(support_started_at,$1),
         support_expires_at=$2, support_tariff=$3, support_requested=FALSE,
         last_payment_at=$1, out_sum=$4 WHERE id=$5`,
        [now.toISOString(), newExpiry.toISOString(), tariffKey, outSum, orderId]
      );
    } else if (pType === 'ticket_once') {
      if (ticketId) {
        await client.query(
          `UPDATE service_tickets SET paid=TRUE, status='open', paid_at=$1 WHERE id=$2`,
          [now.toISOString(), ticketId]
        );
      }
      // Разовая правка не трогает финансы самого заказа — это отдельный платёж.
    } else if (pType === 'partial') {
      const total = await recalcOrderTotal(client, order);
      const remaining = Math.max(0, total - outSum);
      await client.query(
        `UPDATE orders SET total_price=$1, paid_amount=$2, remaining_amount=$3, paid_at=$4,
         last_payment_at=$4, out_sum=$2, status = CASE WHEN status = -1 THEN 0 ELSE status END
         WHERE id=$5`,
        [total, outSum, remaining, now.toISOString(), orderId]
      );
      // Письмо шлём только в момент реального перехода из черновика (-1) в
      // "принят в работу" (0) — раньше это было прописано только в ручных
      // admin-роутах orders.js и никогда не срабатывало для настоящей оплаты.
      if (order.status === -1 && order.client_email) {
        sendNewOrderEmail(order.client_email, {
          orderId: order.id, packageName: order.package, totalPrice: total, paymentId,
        }).catch((e) => console.error('Не удалось отправить письмо о заказе (partial):', e));
      }
      // Счётчик использований промокода — раньше нигде не увеличивался,
      // в админке всегда показывал 0 независимо от реальных применений.
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
      await client.query(
        `UPDATE orders SET paid=TRUE, paid_amount=paid_amount + $1, remaining_amount=0, paid_at=$2,
         last_payment_at=$2, out_sum=$1, status = CASE WHEN status = -1 THEN 0 ELSE status END
         WHERE id=$3`,
        [outSum, now.toISOString(), orderId]
      );
      if (order.status === -1 && order.client_email) {
        sendNewOrderEmail(order.client_email, {
          orderId: order.id, packageName: order.package, totalPrice: order.total_price, paymentId,
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

// ── POST /api/payments/check ── «вернулся ли клиент с недавней успешной оплаты»
// (вызывается из checkPayment.js на Vercel от лица юзера — requireUserOrService)
router.post('/check', requireUserOrService, async (req, res) => {
  const { orderId, type, ticketId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId обязателен' });
  const pType = ['support', 'partial', 'remaining', 'ticket_once'].includes(type) ? type : 'order';

  const { rows: orderRows } = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  if (orderRows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
  const order = orderRows[0];
  if (order.user_id !== req.user.id) return res.status(403).json({ error: 'Не ваш заказ' });

  function isRecent(d) { return !!d && (Date.now() - new Date(d).getTime()) < RECENT_WINDOW_MS; }

  // Номер платежа ЮKассы для отображения на payment_success — раньше не
  // возвращался вообще, страница просто скрывала эту строку.
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
