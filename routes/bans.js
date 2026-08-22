const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

function toClient(b) {
  return {
    userId: b.user_id,
    reason: b.reason,
    until: b.until,
    showButton: b.show_button,
    btnLabel: b.btn_label,
    btnUrl: b.btn_url,
    bannedBy: b.banned_by,
    bannedAt: b.banned_at,
  };
}

// ── GET /api/bans ── список всех банов (только админ), с email/именем юзера
router.get('/', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, u.email, u.display_name
     FROM bans b JOIN users u ON u.id = b.user_id
     ORDER BY b.banned_at DESC`
  );
  res.json(rows.map(b => ({ ...toClient(b), userEmail: b.email, userName: b.display_name })));
});

// ── POST /api/bans ── забанить юзера (по email)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { email, reason, until, showButton, btnLabel, btnUrl } = req.body;
    if (!email || !reason) return res.status(400).json({ error: 'Заполните email и причину' });

    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (userRows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    const userId = userRows[0].id;

    const { rows } = await pool.query(
      `INSERT INTO bans (user_id, reason, until, show_button, btn_label, btn_url, banned_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET reason=$2, until=$3, show_button=$4, btn_label=$5, btn_url=$6, banned_by=$7, banned_at=now()
       RETURNING *`,
      [userId, reason, until || null, !!showButton, btnLabel || null, btnUrl || null, req.user.email]
    );

    // Забаненный юзер больше не должен иметь активных сессий
    await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);

    res.json(toClient(rows[0]));
  } catch (err) {
    console.error('create ban error:', err);
    res.status(500).json({ error: 'Не удалось забанить пользователя' });
  }
});

// ── DELETE /api/bans/:userId ── снять бан
router.delete('/:userId', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM bans WHERE user_id = $1 RETURNING user_id', [req.params.userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Бан не найден' });
  res.json({ ok: true });
});

module.exports = router;
