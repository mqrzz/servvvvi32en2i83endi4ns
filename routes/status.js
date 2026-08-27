const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');
const { sendStatusSubscribedEmail, sendIncidentUpdateEmail } = require('../utils/mailer');
const statusMonitor = require('../lib/statusMonitor');

const router = express.Router();

const UPTIME_DAYS = 90;
const SEVERITIES = ['degraded', 'partial', 'major', 'maint'];
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'];

// Не больше 3 попыток подписки за 10 минут с одного IP — защита от спама формой
const subscribeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ── Считает % аптайма и 90 дневных статусов из status_checks для одного сервиса ──
// Дни считаем по московскому времени (сайт российский), а не по UTC — иначе
// граница "сегодня/вчера" уезжает на 3 часа и путает даже настоящие данные.
const TIMEZONE = 'Europe/Moscow';
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }); // -> YYYY-MM-DD

async function buildUptime(serviceId) {
  const { rows } = await pool.query(
    `SELECT (checked_at AT TIME ZONE '${TIMEZONE}')::date AS day, bool_and(ok) AS all_ok, count(*) AS total
     FROM status_checks
     WHERE service_id = $1 AND checked_at > now() - interval '${UPTIME_DAYS} days'
     GROUP BY day
     ORDER BY day ASC`,
    [serviceId]
  );

  const byDay = new Map(rows.map((r) => [dayKeyFmt.format(r.day), r.all_ok]));

  const days = [];
  let okCount = 0;
  let knownCount = 0;
  for (let i = UPTIME_DAYS - 1; i >= 0; i--) {
    const key = dayKeyFmt.format(new Date(Date.now() - i * 86400000));
    const known = byDay.has(key);
    const ok = known ? byDay.get(key) : null; // null = нет данных за этот день (например сервис без check_url)
    if (known) {
      knownCount++;
      if (ok) okCount++;
    }
    days.push({ date: key, ok });
  }

  const uptimePct = knownCount > 0 ? Math.round((okCount / knownCount) * 10000) / 100 : null;
  return { days, uptimePct };
}

function serviceToClient(s, uptime) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    status: s.status,
    manualOverride: s.manual_override,
    hasCheckUrl: !!s.check_url || s.check_type === 'telegram_webhook',
    uptimePct: uptime.uptimePct,
    days: uptime.days,
  };
}

async function incidentsWithUpdates(limit = 30) {
  const { rows: incidents } = await pool.query(
    `SELECT i.*, s.name as service_name
     FROM status_incidents i
     LEFT JOIN status_services s ON s.id = i.service_id
     ORDER BY i.created_at DESC
     LIMIT $1`,
    [limit]
  );
  if (incidents.length === 0) return [];

  const { rows: updates } = await pool.query(
    `SELECT * FROM status_incident_updates WHERE incident_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
    [incidents.map((i) => i.id)]
  );

  return incidents.map((i) => ({
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    serviceName: i.service_name,
    createdAt: i.created_at,
    resolvedAt: i.resolved_at,
    updates: updates
      .filter((u) => u.incident_id === i.id)
      .map((u) => ({ status: u.status, message: u.message, createdAt: u.created_at })),
  }));
}

// ── GET /api/status ── публичное, отдаёт всё для рендера страницы ──
router.get('/', async (req, res) => {
  try {
    const { rows: services } = await pool.query('SELECT * FROM status_services ORDER BY sort_order');

    const withUptime = await Promise.all(
      services.map(async (s) => serviceToClient(s, await buildUptime(s.id)))
    );

    const incidents = await incidentsWithUpdates();

    const worst = withUptime.reduce((acc, s) => {
      const rank = { ok: 0, degraded: 1, maint: 1, partial: 2, major: 3 };
      return (rank[s.status] || 0) > (rank[acc] || 0) ? s.status : acc;
    }, 'ok');

    res.json({ overall: worst, services: withUptime, incidents, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('GET /api/status error:', err);
    res.status(500).json({ error: 'Не удалось получить статус' });
  }
});

// ── POST /api/status/subscribe ── публичное, подписка на уведомления ──
router.post('/subscribe', subscribeLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Введите корректный email' });

    const token = crypto.randomBytes(24).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO status_subscribers (email, unsubscribe_token) VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING unsubscribe_token`,
      [email, token]
    );
    const finalToken = rows[0].unsubscribe_token;
    const unsubscribeUrl = `https://antviz.ru/api/status/unsubscribe/${finalToken}`;

    sendStatusSubscribedEmail(email, unsubscribeUrl).catch((err) =>
      console.error('sendStatusSubscribedEmail error:', err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/status/subscribe error:', err);
    res.status(500).json({ error: 'Не удалось оформить подписку' });
  }
});

// ── GET /api/status/unsubscribe/:token ── публичное, ссылка из письма ──
router.get('/unsubscribe/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM status_subscribers WHERE unsubscribe_token = $1 RETURNING email',
      [req.params.token]
    );
    if (rows.length === 0) return res.status(404).send('Ссылка недействительна или уже использована.');
    res.send('Вы отписаны от уведомлений о статусе Antviz. Можно закрыть эту страницу.');
  } catch (err) {
    console.error('GET /api/status/unsubscribe error:', err);
    res.status(500).send('Не удалось отписаться, попробуйте позже.');
  }
});

// ════════════════════════════════════════════════════════════
// Ниже — только для админов (requireAdmin), чтобы можно было
// править статус-страницу без прямого доступа к БД.
// ════════════════════════════════════════════════════════════

// ── GET /api/status/services ── полный список для админки (с check_url/check_type) ──
router.get('/services', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM status_services ORDER BY sort_order');
  res.json(rows);
});

// ── POST /api/status/services ── создать сервис ──
router.post('/services', requireAdmin, async (req, res) => {
  try {
    const { name, slug, checkUrl, checkType, sortOrder } = req.body || {};
    if (!name || !slug) return res.status(400).json({ error: 'Заполните название и slug' });
    const type = ['http', 'telegram_webhook'].includes(checkType) ? checkType : 'http';

    const { rows } = await pool.query(
      `INSERT INTO status_services (name, slug, check_url, check_type, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, slug, checkUrl || null, type, Number(sortOrder) || 0]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('POST /api/status/services error:', err);
    res.status(500).json({ error: 'Не удалось создать сервис (возможно, такой slug уже есть)' });
  }
});

// ── PATCH /api/status/services/:id ── изменить сервис / выставить статус вручную ──
router.patch('/services/:id', requireAdmin, async (req, res) => {
  try {
    const { name, checkUrl, checkType, checkHeaders, sortOrder, status, manualOverride } = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;

    if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
    if (checkUrl !== undefined) { fields.push(`check_url = $${i++}`); values.push(checkUrl || null); }
    if (checkType !== undefined) {
      if (!['http', 'telegram_webhook'].includes(checkType)) return res.status(400).json({ error: 'Некорректный check_type' });
      fields.push(`check_type = $${i++}`); values.push(checkType);
    }
    if (checkHeaders !== undefined) { fields.push(`check_headers = $${i++}`); values.push(checkHeaders ? JSON.stringify(checkHeaders) : null); }
    if (sortOrder !== undefined) { fields.push(`sort_order = $${i++}`); values.push(Number(sortOrder) || 0); }
    if (status !== undefined) {
      if (!['ok', ...SEVERITIES].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
      fields.push(`status = $${i++}`); values.push(status);
    }
    if (manualOverride !== undefined) { fields.push(`manual_override = $${i++}`); values.push(!!manualOverride); }

    if (fields.length === 0) return res.status(400).json({ error: 'Нечего обновлять' });

    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE status_services SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Сервис не найден' });

    // Сняли ручную фиксацию — сразу гоняем реальную проверку вместо того чтобы
    // показывать последний вручную выставленный статус ещё до 5 минут (следующий
    // плановый цикл монитора). Без этого выглядело так, будто статус "сам поменялся".
    if (manualOverride === false) {
      await statusMonitor.checkService(req.params.id).catch((err) =>
        console.error('PATCH /services/:id: мгновенная перепроверка не удалась:', err)
      );
      const { rows: fresh } = await pool.query('SELECT * FROM status_services WHERE id = $1', [req.params.id]);
      return res.json(fresh[0]);
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/status/services/:id error:', err);
    res.status(500).json({ error: 'Не удалось обновить сервис' });
  }
});

// ── DELETE /api/status/services/:id ──
router.delete('/services/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM status_services WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ── Рассылка обновления всем подписчикам (используется при создании инцидента и апдейтов) ──
async function notifySubscribers({ incidentTitle, status, message }) {
  const { rows: subs } = await pool.query('SELECT email, unsubscribe_token FROM status_subscribers');
  await Promise.all(
    subs.map((s) =>
      sendIncidentUpdateEmail(s.email, {
        incidentTitle,
        status,
        message,
        unsubscribeUrl: `https://antviz.ru/api/status/unsubscribe/${s.unsubscribe_token}`,
      }).catch((err) => console.error(`notifySubscribers: не удалось отправить на ${s.email}:`, err))
    )
  );
}

// ── POST /api/status/incidents ── создать инцидент (+ первая запись таймлайна) ──
router.post('/incidents', requireAdmin, async (req, res) => {
  try {
    const { title, severity, serviceId, message } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'Заполните заголовок и описание' });
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Некорректная серьёзность' });

    const { rows: incRows } = await pool.query(
      `INSERT INTO status_incidents (service_id, title, severity, status, created_by)
       VALUES ($1,$2,$3,'investigating',$4) RETURNING *`,
      [serviceId || null, title, severity, req.user.email]
    );
    const incident = incRows[0];

    await pool.query(
      `INSERT INTO status_incident_updates (incident_id, status, message, created_by)
       VALUES ($1,'investigating',$2,$3)`,
      [incident.id, message, req.user.email]
    );

    // Пока инцидент открыт — статус сервиса подсвечивается его severity (если не override)
    if (serviceId) {
      await pool.query(
        `UPDATE status_services SET status = $1 WHERE id = $2 AND manual_override = FALSE`,
        [severity, serviceId]
      );
    }

    notifySubscribers({ incidentTitle: title, status: 'investigating', message }).catch((err) =>
      console.error('notifySubscribers error:', err)
    );

    res.json(incident);
  } catch (err) {
    console.error('POST /api/status/incidents error:', err);
    res.status(500).json({ error: 'Не удалось создать инцидент' });
  }
});

// ── POST /api/status/incidents/:id/updates ── добавить запись в таймлайн (и разослать) ──
router.post('/incidents/:id/updates', requireAdmin, async (req, res) => {
  try {
    const { status, message } = req.body || {};
    if (!INCIDENT_STATUSES.includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
    if (!message) return res.status(400).json({ error: 'Опишите обновление' });

    const { rows: incRows } = await pool.query('SELECT * FROM status_incidents WHERE id = $1', [req.params.id]);
    if (incRows.length === 0) return res.status(404).json({ error: 'Инцидент не найден' });
    const incident = incRows[0];

    await pool.query(
      `INSERT INTO status_incident_updates (incident_id, status, message, created_by) VALUES ($1,$2,$3,$4)`,
      [incident.id, status, message, req.user.email]
    );
    await pool.query(
      `UPDATE status_incidents SET status = $1, resolved_at = $2 WHERE id = $3`,
      [status, status === 'resolved' ? new Date() : null, incident.id]
    );

    // Инцидент устранён — пересчитываем статус сервиса по ОСТАВШИМСЯ открытым
    // инцидентам (если есть другой открытый инцидент на этот же сервис — статус
    // должен остаться на его severity, а не сброситься в 'ok' вслепую)
    if (status === 'resolved' && incident.service_id) {
      const { rows: stillOpen } = await pool.query(
        `SELECT severity FROM status_incidents WHERE service_id = $1 AND status != 'resolved' AND id != $2`,
        [incident.service_id, incident.id]
      );
      const rank = { degraded: 1, maint: 1, partial: 2, major: 3 };
      const worst = stillOpen.reduce((acc, r) => (rank[r.severity] > rank[acc] ? r.severity : acc), null);

      await pool.query(
        `UPDATE status_services SET status = $1 WHERE id = $2 AND manual_override = FALSE`,
        [worst || 'ok', incident.service_id]
      );
    }

    notifySubscribers({ incidentTitle: incident.title, status, message }).catch((err) =>
      console.error('notifySubscribers error:', err)
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/status/incidents/:id/updates error:', err);
    res.status(500).json({ error: 'Не удалось добавить обновление' });
  }
});

// ── DELETE /api/status/incidents/:id ── удалить инцидент целиком (например, создан по ошибке) ──
router.delete('/incidents/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM status_incidents WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
