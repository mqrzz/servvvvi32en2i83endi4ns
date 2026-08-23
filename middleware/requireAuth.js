const pool = require('../db/pool');
const { verifySessionToken, hashToken, verifyServiceToken } = require('../utils/tokens');

// Проверяет cookie с токеном, находит активную сессию в БД, кладёт req.user
async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  const payload = verifySessionToken(token);
  if (!payload) return res.status(401).json({ error: 'Сессия недействительна' });

  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT s.id as session_id, u.id, u.email, u.display_name, u.role, u.photo_url, u.onboarding_done, u.created_at
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

// Для эндпоинтов, которые дёргает и браузер (через cookie), и доверенные
// сторонние сервисы от лица юзера (Vercel payment-функции — через короткоживущий
// сервисный токен, см. utils/tokens.js). Пробуем cookie первой, иначе — заголовок
// Authorization: Bearer <service token>.
async function requireUserOrService(req, res, next) {
  if (req.cookies?.session) return requireAuth(req, res, next);

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизован' });

  const payload = verifyServiceToken(token);
  if (!payload) return res.status(401).json({ error: 'Недействительный или истёкший токен' });

  const { rows } = await pool.query(
    'SELECT id, email, display_name, role, photo_url FROM users WHERE id = $1',
    [payload.uid]
  );
  if (rows.length === 0) return res.status(401).json({ error: 'Пользователь не найден' });

  req.user = { ...rows[0], session_id: null };
  next();
}

module.exports = { requireAuth, requireAdmin, requireUserOrService };
