const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/requireAuth');
const {
  TIER_PRICES, EXTRA_PRICES, SUPPORT_TARIFFS, DEFAULT_SUPPORT_TARIFF,
  ONE_OFF_TICKET_PRICE, recalcOrderTotal,
} = require('../utils/pricing');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    tierPrices: TIER_PRICES,
    extraPrices: EXTRA_PRICES,
    supportTariffs: SUPPORT_TARIFFS,
    defaultSupportTariff: DEFAULT_SUPPORT_TARIFF,
    oneOffTicketPrice: ONE_OFF_TICKET_PRICE,
  });
});

router.post('/quote', requireAuth, async (req, res) => {
  const body = req.body || {};
  const pkg = body.package;
  const extras = Array.isArray(body.extras) ? body.extras : [];
  const promoCode = body.promoCode || null;

  if (!pkg || !Object.prototype.hasOwnProperty.call(TIER_PRICES, pkg)) {
    return res.status(400).json({ error: 'unknown package' });
  }

  try {
    const { total, discount } = await recalcOrderTotal(pool, {
      package: pkg,
      extras,
      promo_code: promoCode,
      user_id: req.user.id,
    });
    res.json({ total, discount, halfAmount: Math.ceil(total / 2) });
  } catch (e) {
    console.error('Ошибка расчёта quote:', e.message);
    res.status(500).json({ error: 'quote calculation failed' });
  }
});

module.exports = router;
