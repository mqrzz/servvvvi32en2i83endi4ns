// Цены пакетов и опций берём из того же набора, что и сайт и калькулятор (site-prices.json).
// Файл собирается из frontend/assets/js/prices.js: при смене цен на сайте обновите его (см. build.py).
const SITE = require('./site-prices.json');
const TIER_PRICES = Object.fromEntries(SITE.types.map((t) => [t.id, t.base]));
const EXTRA_PRICES = Object.fromEntries(SITE.options.map((o) => [o.id, o.price]));
const RUSH_RATE = SITE.rush - 1;

const SUPPORT_TARIFFS = {
  basic:    { price: 250,  limit: 5 },
  priority: { price: 600, limit: 20 },
};
const DEFAULT_SUPPORT_TARIFF = 'basic';
const ONE_OFF_TICKET_PRICE = 175;

async function recalcOrderTotal(client, order) {
  const base = TIER_PRICES[order.package];
  if (base == null) return { total: Number(order.total_price) || 0, discount: 0 };

  let running = base;
  const extras = Array.isArray(order.extras) ? order.extras : [];
  for (const key of Object.keys(EXTRA_PRICES)) if (extras.includes(key)) running += EXTRA_PRICES[key];
  if (extras.includes('urgent')) running += Math.round(running * RUSH_RATE);

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
