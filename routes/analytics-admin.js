const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();
router.use(requireAdmin);

const TZ = 'Europe/Moscow';

router.get('/summary', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const since = `now() - ($1::int * interval '1 day')`;
    const prevFrom = `now() - ($1::int * 2 * interval '1 day')`;

    const [series, totals, prev, pages, refs, devices, tgWhere, blog, geo] = await Promise.all([
      pool.query(
        `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
                COALESCE(v.views, 0)::int AS views,
                COALESCE(v.visitors, 0)::int AS visitors,
                COALESCE(v.tg, 0)::int AS tg
         FROM generate_series((now() AT TIME ZONE '${TZ}')::date - ($1::int - 1), (now() AT TIME ZONE '${TZ}')::date, interval '1 day') d
         LEFT JOIN (
           SELECT (ts AT TIME ZONE '${TZ}')::date AS day,
                  count(*) FILTER (WHERE kind = 'pv') AS views,
                  count(DISTINCT visitor) FILTER (WHERE kind = 'pv') AS visitors,
                  count(*) FILTER (WHERE kind = 'tg') AS tg
           FROM analytics_events WHERE ts > ${since} GROUP BY 1
         ) v ON v.day = d::date
         ORDER BY d`,
        [days]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE kind = 'pv')::int AS views,
                count(*) FILTER (WHERE kind = 'tg')::int AS tg,
                count(*) FILTER (WHERE kind = 'read')::int AS reads
         FROM analytics_events WHERE ts > ${since}`,
        [days]
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE kind = 'pv')::int AS views,
                count(*) FILTER (WHERE kind = 'tg')::int AS tg,
                count(*) FILTER (WHERE kind = 'read')::int AS reads
         FROM analytics_events WHERE ts > ${prevFrom} AND ts <= ${since}`,
        [days]
      ),
      pool.query(
        `SELECT path, count(*)::int AS views FROM analytics_events
         WHERE kind = 'pv' AND ts > ${since} GROUP BY path ORDER BY views DESC LIMIT 12`,
        [days]
      ),
      pool.query(
        `SELECT COALESCE(ref, 'Прямые заходы') AS ref, count(*)::int AS views FROM analytics_events
         WHERE kind = 'pv' AND ts > ${since} GROUP BY 1 ORDER BY views DESC LIMIT 8`,
        [days]
      ),
      pool.query(
        `SELECT device, count(*)::int AS views FROM analytics_events
         WHERE kind = 'pv' AND ts > ${since} GROUP BY device ORDER BY views DESC`,
        [days]
      ),
      pool.query(
        `SELECT COALESCE(extra, 'без подписи') AS label, path, count(*)::int AS clicks FROM analytics_events
         WHERE kind = 'tg' AND ts > ${since} GROUP BY 1, 2 ORDER BY clicks DESC LIMIT 10`,
        [days]
      ),
      pool.query(
        `SELECT path,
                count(*) FILTER (WHERE kind = 'pv')::int AS views,
                count(*) FILTER (WHERE kind = 'read')::int AS reads,
                count(*) FILTER (WHERE kind = 'tg')::int AS tg
         FROM analytics_events
         WHERE ts > ${since} AND path LIKE '/blog/%' AND path <> '/blog/'
         GROUP BY path ORDER BY views DESC LIMIT 30`,
        [days]
      ),
      pool.query(
        `SELECT COALESCE(country, '??') AS country, COALESCE(city, '') AS city, count(*)::int AS views, count(DISTINCT ip)::int AS ips
         FROM analytics_events WHERE kind = 'pv' AND ts > ${since} GROUP BY 1, 2 ORDER BY views DESC LIMIT 12`,
        [days]
      ),
    ]);

    const visitors = series.rows.reduce((s, r) => s + r.visitors, 0);
    res.json({
      days,
      totals: { ...totals.rows[0], visitors },
      prev: prev.rows[0],
      series: series.rows,
      pages: pages.rows,
      refs: refs.rows,
      devices: devices.rows,
      tgWhere: tgWhere.rows,
      blog: blog.rows,
      geo: geo.rows,
    });
  } catch (err) {
    console.error('analytics-admin/summary:', err);
    res.status(500).json({ error: 'Не удалось получить статистику' });
  }
});


router.get('/visitors', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
    const { rows } = await pool.query(
      `SELECT ip,
              max(country) AS country, max(city) AS city,
              (array_agg(device ORDER BY ts DESC))[1] AS device,
              count(*) FILTER (WHERE kind = 'pv')::int AS views,
              count(*) FILTER (WHERE kind = 'tg')::int AS tg,
              min(ts) AS first_seen, max(ts) AS last_seen,
              (array_agg(path ORDER BY ts DESC) FILTER (WHERE kind = 'pv'))[1] AS last_path,
              (array_agg(ref ORDER BY ts ASC) FILTER (WHERE ref IS NOT NULL))[1] AS ref
       FROM analytics_events
       WHERE ip IS NOT NULL AND ts > now() - ($1::int * interval '1 day')
       GROUP BY ip ORDER BY max(ts) DESC LIMIT 200`,
      [days]
    );
    res.json(rows);
  } catch (err) {
    console.error('analytics-admin/visitors:', err);
    res.status(500).json({ error: 'Не удалось получить посетителей' });
  }
});

router.get('/visitor', async (req, res) => {
  try {
    const ip = String(req.query.ip || '').slice(0, 64);
    const { rows } = await pool.query(
      `SELECT ts, kind, path, ref, extra FROM analytics_events WHERE ip = $1 ORDER BY ts DESC LIMIT 200`,
      [ip]
    );
    res.json(rows);
  } catch (err) {
    console.error('analytics-admin/visitor:', err);
    res.status(500).json({ error: 'Не удалось получить историю' });
  }
});


/* ---------- «Узел»: модерация ---------- */
const fs = require('fs');
const path = require('path');
const UZEL_UPLOAD_DIR = process.env.UZEL_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'uzel');

// изменяющие запросы только с нашего заголовка (защита от CSRF)
function needAdminHeader(req, res, next) {
  if (req.get('x-requested-with') !== 'antviz-admin') return res.status(403).json({ error: 'Запрос отклонён' });
  next();
}

router.get('/uzel/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM uzel_users)::int AS users,
              (SELECT count(*) FROM uzel_users WHERE created_at > now() - interval '7 days')::int AS new_users,
              (SELECT count(*) FROM uzel_pages)::int AS pages,
              (SELECT count(*) FROM uzel_pages WHERE hidden)::int AS hidden,
              (SELECT count(*) FROM uzel_events WHERE kind = 'view' AND ts > now() - interval '7 days')::int AS views7,
              (SELECT count(*) FROM uzel_events WHERE kind = 'click' AND ts > now() - interval '7 days')::int AS clicks7,
              (SELECT count(*) FROM uzel_reports WHERE NOT handled)::int AS open_reports`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('analytics-admin/uzel/summary:', err);
    res.status(500).json({ error: 'Не удалось загрузить данные Узла' });
  }
});

router.get('/uzel/pages', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    const { rows } = await pool.query(
      `SELECT p.id, p.slug, p.name, p.subtitle, p.avatar, p.theme, p.published, p.hidden, p.created_at, p.updated_at,
              jsonb_array_length(p.links) AS links_count,
              u.id AS user_id, u.email, u.banned, u.last_login_at,
              COALESCE(v.views, 0)::int AS views7,
              COALESCE(v.clicks, 0)::int AS clicks7,
              (SELECT count(*) FROM uzel_reports r WHERE r.page_id = p.id AND NOT r.handled)::int AS open_reports
         FROM uzel_pages p
         JOIN uzel_users u ON u.id = p.user_id
         LEFT JOIN (SELECT page_id, count(*) FILTER (WHERE kind = 'view') AS views, count(*) FILTER (WHERE kind = 'click') AS clicks
                      FROM uzel_events WHERE ts > now() - interval '7 days' GROUP BY page_id) v ON v.page_id = p.id
        WHERE ($1 = '' OR lower(p.slug) LIKE '%' || $1 || '%' OR lower(p.name) LIKE '%' || $1 || '%' OR lower(u.email) LIKE '%' || $1 || '%')
        ORDER BY (SELECT count(*) FROM uzel_reports r WHERE r.page_id = p.id AND NOT r.handled) DESC, p.created_at DESC
        LIMIT 200`,
      [q.replace(/[%_\\]/g, '')]
    );
    res.json(rows);
  } catch (err) {
    console.error('analytics-admin/uzel/pages:', err);
    res.status(500).json({ error: 'Не удалось загрузить страницы' });
  }
});

router.get('/uzel/reports', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const { rows } = await pool.query(
      `SELECT r.id, r.reason, r.details, r.handled, r.created_at, p.id AS page_id, p.slug, p.name, p.hidden
         FROM uzel_reports r JOIN uzel_pages p ON p.id = r.page_id
        WHERE ($1 OR NOT r.handled)
        ORDER BY r.handled ASC, r.created_at DESC LIMIT 200`,
      [all]
    );
    res.json(rows);
  } catch (err) {
    console.error('analytics-admin/uzel/reports:', err);
    res.status(500).json({ error: 'Не удалось загрузить жалобы' });
  }
});

router.post('/uzel/pages/:id/hide', needAdminHeader, async (req, res) => {
  try {
    const hidden = req.body && req.body.hidden === false ? false : true;
    const r = await pool.query('UPDATE uzel_pages SET hidden = $2, updated_at = now() WHERE id = $1 RETURNING id, hidden', [parseInt(req.params.id, 10) || 0, hidden]);
    if (!r.rows.length) return res.status(404).json({ error: 'Страница не найдена' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('analytics-admin/uzel/hide:', err);
    res.status(500).json({ error: 'Не удалось изменить страницу' });
  }
});

// Блокировка владельца: страница скрыта, все сессии закрыты, войти по коду больше нельзя
router.post('/uzel/pages/:id/ban', needAdminHeader, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    const p = await pool.query('SELECT user_id FROM uzel_pages WHERE id = $1', [id]);
    if (!p.rows.length) return res.status(404).json({ error: 'Страница не найдена' });
    const uid = p.rows[0].user_id;
    const banned = req.body && req.body.banned === false ? false : true;
    await pool.query('UPDATE uzel_users SET banned = $2 WHERE id = $1', [uid, banned]);
    if (banned) {
      await pool.query('UPDATE uzel_pages SET hidden = true, updated_at = now() WHERE id = $1', [id]);
      await pool.query('DELETE FROM uzel_sessions WHERE user_id = $1', [uid]);
    }
    res.json({ ok: true, banned });
  } catch (err) {
    console.error('analytics-admin/uzel/ban:', err);
    res.status(500).json({ error: 'Не удалось заблокировать владельца' });
  }
});

// Полное удаление страницы вместе с аккаунтом (если владелец заблокирован, запись о блокировке сохраняется)
router.post('/uzel/pages/:id/delete', needAdminHeader, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10) || 0;
    const p = await pool.query(
      `SELECT p.avatar, p.user_id, u.banned FROM uzel_pages p JOIN uzel_users u ON u.id = p.user_id WHERE p.id = $1`, [id]
    );
    if (!p.rows.length) return res.status(404).json({ error: 'Страница не найдена' });
    const row = p.rows[0];
    if (row.banned) {
      // блокировку не теряем: удаляем только страницу и сессии, учётная запись остаётся заблокированной
      await pool.query('DELETE FROM uzel_pages WHERE id = $1', [id]);
      await pool.query('DELETE FROM uzel_sessions WHERE user_id = $1', [row.user_id]);
    } else {
      await pool.query('DELETE FROM uzel_users WHERE id = $1', [row.user_id]);
    }
    if (row.avatar && /^[a-zA-Z0-9._-]+$/.test(row.avatar)) fs.unlink(path.join(UZEL_UPLOAD_DIR, row.avatar), () => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('analytics-admin/uzel/delete:', err);
    res.status(500).json({ error: 'Не удалось удалить страницу' });
  }
});

router.post('/uzel/reports/:id/handle', needAdminHeader, async (req, res) => {
  try {
    const handled = req.body && req.body.handled === false ? false : true;
    const r = await pool.query('UPDATE uzel_reports SET handled = $2 WHERE id = $1 RETURNING id, handled', [parseInt(req.params.id, 10) || 0, handled]);
    if (!r.rows.length) return res.status(404).json({ error: 'Жалоба не найдена' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('analytics-admin/uzel/handle:', err);
    res.status(500).json({ error: 'Не удалось обновить жалобу' });
  }
});

module.exports = router;
