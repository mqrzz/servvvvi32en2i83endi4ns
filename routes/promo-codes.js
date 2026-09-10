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
    usageLimit: p.usage_limit,
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
  if (promo.usage_limit != null && promo.used_count >= promo.usage_limit) {
    return res.status(400).json({ error: 'Лимит использований промокода исчерпан' });
  }
  if (promo.for_user_id && promo.for_user_id !== req.user.id) {
    return res.status(400).json({ error: 'Этот промокод вам не подходит' });
  }

  res.json({ code: promo.code, discountType: promo.discount_type, discountValue: Number(promo.discount_value) });
});

// ── POST /api/promo-codes ── создать промокод (только админ)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { code, discountType, discountValue, expiresAt, forUserId, usageLimit } = req.body;
    if (!code || !discountType || !discountValue) return res.status(400).json({ error: 'Заполните обязательные поля' });
    if (!['percent', 'fixed'].includes(discountType)) return res.status(400).json({ error: 'Некорректный тип скидки' });
    if (usageLimit != null && (!Number.isInteger(usageLimit) || usageLimit < 1)) {
      return res.status(400).json({ error: 'Лимит использований должен быть целым числом больше 0' });
    }

    const { rows } = await pool.query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, expires_at, for_user_id, usage_limit)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [code.trim().toUpperCase(), discountType, discountValue, expiresAt || null, forUserId || null, usageLimit || null]
    );
    res.json(toClient(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой промокод уже существует' });
    console.error('create promo error:', err);
    res.status(500).json({ error: 'Не удалось создать промокод' });
  }
});

// ── PATCH /api/promo-codes/:id ── включить/выключить, изменить лимит (только админ)
router.patch('/:id', requireAdmin, async (req, res) => {
  const { active, usageLimit } = req.body;
  const sets = [];
  const values = [];
  let i = 1;
  if (active !== undefined) { sets.push(`active = $${i++}`); values.push(!!active); }
  if (usageLimit !== undefined) {
    if (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1)) {
      return res.status(400).json({ error: 'Лимит использований должен быть целым числом больше 0' });
    }
    sets.push(`usage_limit = $${i++}`); values.push(usageLimit);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  values.push(req.params.id);
  const { rows } = await pool.query(`UPDATE promo_codes SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  if (rows.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
  res.json(toClient(rows[0]));
});

// ── DELETE /api/promo-codes/:id ── удалить (только админ)
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM promo_codes WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Промокод не найден' });
  res.json({ ok: true });
});

module.exports = router;
