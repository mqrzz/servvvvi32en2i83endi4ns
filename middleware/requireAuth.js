const pool = require('../db/pool');
const { verifySessionToken, hashToken, verifyServiceToken } = require('../utils/tokens');

async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  const payload = verifySessionToken(token);
  if (!payload) return res.status(401).json({ error: 'Сессия недействительна' });

  const tokenHash = hashToken(token);

  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT s.id as session_id, u.id, u.email, u.display_name, u.role, u.photo_url, u.onboarding_done, u.created_at,
              u.telegram_id, u.telegram_username
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash]
    ));
  } catch (err) {
    console.error('requireAuth: ошибка запроса к БД при проверке сессии:', err);
    return res.status(500).json({ error: 'Временная ошибка проверки сессии, попробуйте ещё раз' });
  }

  if (rows.length === 0) {
    return res.status(401).json({ error: 'Сессия истекла или отозвана' });
  }

  req.user = rows[0];

  pool.query('UPDATE sessions SET last_active_at = now() WHERE id = $1', [rows[0].session_id]).catch((err) => {
    console.error('requireAuth: не удалось обновить last_active_at:', err);
  });

  next();
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    next();
  });
}

async function requireUserOrService(req, res, next) {
  if (req.cookies?.session) return requireAuth(req, res, next);

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  const payload = verifyServiceToken(token);
  if (!payload) return res.status(401).json({ error: 'Недействительный или истёкший токен' });

  let rows;
  try {
    ({ rows } = await pool.query(
      'SELECT id, email, display_name, role, photo_url FROM users WHERE id = $1',
      [payload.uid]
    ));
  } catch (err) {
    console.error('requireUserOrService: ошибка запроса к БД:', err);
    return res.status(500).json({ error: 'Временная ошибка проверки доступа, попробуйте ещё раз' });
  }
  if (rows.length === 0) return res.status(401).json({ error: 'Пользователь не найден' });

  req.user = { ...rows[0], session_id: null };
  next();
}

async function optionalAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return next();
  const payload = verifySessionToken(token);
  if (!payload) return next();
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.display_name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [hashToken(token)]
    );
    if (rows.length) req.user = rows[0];
  } catch (err) {
    console.error('optionalAuth: ошибка проверки сессии (продолжаем анонимно):', err);
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireUserOrService, optionalAuth };
