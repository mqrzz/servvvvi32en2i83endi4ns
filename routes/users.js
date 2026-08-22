const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// ── GET /api/users ── список всех пользователей (только админ, для рассылок и т.д.)
router.get('/', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, role, created_at FROM users ORDER BY created_at DESC`
  );
  res.json(rows.map(u => ({
    id: u.id,
    email: u.email,
    displayName: u.display_name,
    role: u.role,
    createdAt: u.created_at,
  })));
});

module.exports = router;
