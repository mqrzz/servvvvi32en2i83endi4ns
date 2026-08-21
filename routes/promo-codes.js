const express = require('express');
const pool = require('../db/pool');
const { requireAuth, requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

function toClient(p) {
  return {
    id: p.id,
    code: p.code,
    discountType: p.discount_type,
    discountValue: Number(p.discount_value),
    active: p.active,
    usedCount: p.used_count,
    expiresAt: p.expires_at,
    forUserId: p.for_user_id,
    createdAt: p.created_at,
  };
}

// ── GET /api/promo-codes/admin/all ── все промокоды (только админ)
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
  res.json(rows.map(toClient));
});

// ── GET /api/promo-codes/:code ── проверить промокод (для формы заказа)
router.get('/:code', requireAuth, async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  const { rows } = await pool.query('SELECT * FROM promo_codes WHERE UPPER(code) = $1 AND active = TRUE', [code]);
  if (rows.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
  const promo = rows[0];

  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return res.status(400).json({ error: 'Срок действия истёк' });
  }
  if (promo.for_user_id && promo.for_user_id !== req.user.id) {
    return res.status(400).json({ error: 'Этот промокод вам не подходит' });
  }

  res.json({ code: promo.code, discountType: promo.discount_type, discountValue: Number(promo.discount_value) });
});

// ── POST /api/promo-codes ── создать промокод (только админ)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { code, discountType, discountValue, expiresAt, forUserId } = req.body;
    if (!code || !discountType || !discountValue) return res.status(400).json({ error: 'Заполните обязательные поля' });
    if (!['percent', 'fixed'].includes(discountType)) return res.status(400).json({ error: 'Некорректный тип скидки' });

    const { rows } = await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, expires_at, for_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [code.trim().toUpperCase(), discountType, discountValue, expiresAt || null, forUserId || null]
    );
    res.json(toClient(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой промокод уже существует' });
    console.error('create promo error:', err);
    res.status(500).json({ error: 'Не удалось создать промокод' });
  }
});

// ── PATCH /api/promo-codes/:id ── включить/выключить (только админ)
router.patch('/:id', requireAdmin, async (req, res) => {
  const { active } = req.body;
  const { rows } = await pool.query('UPDATE promo_codes SET active = $1 WHERE id = $2 RETURNING *', [!!active, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
  res.json(toClient(rows[0]));
});

module.exports = router;
