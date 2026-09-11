// Единый расчёт суммы заказа на бэкенде — используется и при создании
// заказа (routes/orders.js, чтобы не доверять totalPrice/remainingAmount,
// присланным браузером клиента), и при пересчёте суммы в момент оплаты
// (routes/payments.js, recalcOrderTotal). Вынесено в отдельный файл без
// зависимостей от orders.js/payments.js, чтобы не создавать циклический
// require между ними.
//
// ⚠️ ЦЕНЫ ЗАДУБЛИРОВАНЫ ЕЩЁ В ДВУХ МЕСТАХ (два разных деплоя, общий модуль
// туда напрямую не подключить): в order/index.html (TIERS, для отображения
// клиенту на форме заказа) и в mqrz/api/pricing.js (TIER_PRICES/EXTRA_PRICES,
// формирует сумму при создании платежа через ЮKassa). Поменял цену тут —
// обязательно поменяй и в тех двух файлах.

const TIER_PRICES = {
  'Старт': 2900, 'Рост': 5900, 'Масштаб': 11900,
  'Простой бот': 4900, 'Бот с оплатой': 9900, 'Mini App': 16900,
};
const EXTRA_PRICES = { content: 2000, shop: 4900, bot_pay: 3000, bot_crm: 2500 };

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

module.exports = { TIER_PRICES, EXTRA_PRICES, recalcOrderTotal };
