const pool = require('../db/pool');
const { verifySessionToken, hashToken } = require('../utils/tokens');

// Проверяет cookie с токеном, находит активную сессию в БД, кладёт req.user
async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  const payload = verifySessionToken(token);
  if (!payload) return res.status(401).json({ error: 'Сессия недействительна' });

  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT s.id as session_id, u.id, u.email, u.display_name, u.role, u.photo_url
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [tokenHash]
  );

  if (rows.length === 0) {
    return res.status(401).json({ error: 'Сессия истекла или отозвана' });
  }

  req.user = rows[0];

  // Обновляем "последняя активность" не блокируя ответ
  pool.query('UPDATE sessions SET last_active_at = now() WHERE id = $1', [rows[0].session_id]).catch(() => {});

  next();
}

// То же самое, но требует роль admin
async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin };
