// ЕДИНЫЙ источник цен на бэкенде. Раньше эти же числа были захардкожены
// ЕЩЁ в двух местах (order/index.html и mqrz/api/pricing.js) — из-за этого
// суммарно и завелась история "показывается одна цена, в ЮKассе другая":
// каждое место считало сумму заказа заново, своей копией формулы, и любое
// расхождение (забытая правка цены, протухший на полпути промокод) сразу
// било по факту оплаты. Теперь так:
//   - здесь — единственное место, где цены прописаны буквально;
//   - GET /api/pricing отдаёт эти же числа наружу для отображения
//     (order/index.html, profile/tickets.html — просто фетчат при загрузке,
//     ничего не хардкодят);
//   - POST /api/orders/quote отдаёт точную сумму с учётом промокода —
//     им можно свериться перед оплатой;
//   - mqrz/api/createPayment.js для типов order/partial/remaining вообще
//     больше не пересчитывает сумму сам, а берёт уже сохранённые
//     totalPrice/paidAmount/remainingAmount заказа (посчитанные один раз
//     здесь же, при создании заказа в routes/orders.js, и обновляемые
//     здесь же вебхуком в routes/payments.js) — то есть "показанная" и
//     "списанная" сумма гарантированно одно и то же число из одного места.
//   - для support/ticket_once (плоские тарифы без промокода) createPayment
//     тоже спрашивает актуальные цифры у GET /api/pricing, а не хранит их
//     у себя.
const TIER_PRICES = {
  'Старт': 2900, 'Рост': 5900, 'Масштаб': 11900,
  'Простой бот': 4900, 'Бот с оплатой': 9900, 'Mini App': 16900,
};
const EXTRA_PRICES = { content: 2000, shop: 4900, bot_pay: 3000, bot_crm: 2500 };

const SUPPORT_TARIFFS = {
  basic:    { price: 500,  limit: 5 },
  priority: { price: 1200, limit: 20 },
};
const DEFAULT_SUPPORT_TARIFF = 'basic';
const ONE_OFF_TICKET_PRICE = 350;

// Пересчитываем сумму заново на сервере, а не доверяем тому, что прислал
// клиент — если промокод к этому моменту истёк/деактивирован/исчерпал лимит,
// скидка больше не применяется.
//
// client — любой объект с методом .query (pool или client активной
// транзакции); order — объект с полями package, extras (массив),
// promo_code, user_id (snake_case — как в БД).
async function recalcOrderTotal(client, order) {
  const base = TIER_PRICES[order.package];
  if (base == null) return { total: Number(order.total_price) || 0, discount: 0 }; // неизвестный тариф — не пересчитываем

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
      const limitReached = p.usage_limit != null && p.used_count >= p.usage_limit;
      if (!expired && !wrongUser && !limitReached) {
        discount = p.discount_type === 'percent'
          ? Math.round(running * p.discount_value / 100)
          : Math.min(Number(p.discount_value), running);
      }
    }
  }

  return { total: Math.max(0, running - discount), discount };
}

module.exports = {
  TIER_PRICES, EXTRA_PRICES, recalcOrderTotal,
  SUPPORT_TARIFFS, DEFAULT_SUPPORT_TARIFF, ONE_OFF_TICKET_PRICE,
};
