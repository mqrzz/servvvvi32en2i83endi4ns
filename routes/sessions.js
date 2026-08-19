const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// ── GET /api/sessions ── список всех активных устройств текущего юзера
router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, device_name, ip_address, last_active_at, created_at,
            (id = $2) as is_current
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_active_at DESC`,
    [req.user.id, req.user.session_id]
  );
  res.json(rows);
});

// ── DELETE /api/sessions/:id ── завершить конкретный сеанс (выйти с одного устройства)
router.delete('/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [req.params.id, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Сессия не найдена' });
  res.json({ ok: true });
});

// ── DELETE /api/sessions ── завершить все сеансы, кроме текущего ("выйти со всех устройств")
router.delete('/', requireAuth, async (req, res) => {
  await pool.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND id != $2 AND revoked_at IS NULL`,
    [req.user.id, req.user.session_id]
  );
  res.json({ ok: true });
});

module.exports = router;
