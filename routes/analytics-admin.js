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

module.exports = router;
