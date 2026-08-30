const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const disposableDomains = require('disposable-email-domains');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');
const { sendStatusSubscribedEmail, sendIncidentUpdateEmail } = require('../utils/mailer');
const statusMonitor = require('../lib/statusMonitor');
const { notifySubscribers } = require('../lib/statusNotify');

const router = express.Router();

const disposableSet = new Set(disposableDomains);
function isDisposableEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? disposableSet.has(domain) : false;
}

// ── Настоящая проверка капчи на бэкенде (не через сторонний прокси, а
// напрямую в Cloudflare Turnstile) — без валидного токена подписка не пройдёт.
// Нужен TURNSTILE_SECRET_KEY в .env (Cloudflare Dashboard -> Turnstile -> сайт -> Secret Key,
// та же пара, что и sitekey 0x4AAAAAADsZsKfyIeKi6Yr- на фронте).
// Проверка капчи — через тот же самый Vercel-прокси, что уже используется на
// логине/регистрации (cloudflarecaptcha900374938.vercel.app), просто вызываем его
// с бэкенда, а не с фронта — так проверку нельзя обойти правкой JS в браузере.
// Никакого отдельного секретного ключа на этом сервере не нужно — он уже есть
// в том Vercel-проекте, ровно как для входа/регистрации.
async function verifyTurnstile(token) {
  if (!token) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch('https://cloudflarecaptcha900374938.vercel.app/api/verifyTurnstile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    return !!data.success;
  } catch (err) {
    console.error('verifyTurnstile: прокси недоступен:', err);
    return false; // строгий режим — недоступна проверка -> считаем, что не пройдена
  }
}


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
    `SELECT (checked_at AT TIME ZONE '${TIMEZONE}')::date AS day,
            count(*) FILTER (WHERE ok) AS ok_count,
            count(*) AS total
     FROM status_checks
     WHERE service_id = $1 AND checked_at > now() - interval '${UPTIME_DAYS} days'
     GROUP BY day
     ORDER BY day ASC`,
    [serviceId]
  );

  // day -> {okCount, total}. Если за день упали НЕ ВСЕ проверки — статус 'degraded'
  // (жёлтый), а не 'major' (красный) — красный только если упало вообще всё.
  const byDay = new Map(rows.map((r) => [dayKeyFmt.format(r.day), { ok: Number(r.ok_count), total: Number(r.total) }]));

  // Типичное число проверок за день (раз в 5 минут) — используется как "вес"
  // дня без данных, чтобы он засчитывался как полностью нормальный, а не просто
  // выпадал из расчёта. Так пара реально плохих дней не портит картину, если
  // остальные 88 дней сервис ещё не мониторился (или мониторился, но данные
  // почистили) — они считаются "в порядке", а не игнорируются нейтрально.
  const ASSUMED_CHECKS_PER_DAY = Math.round((24 * 60) / 5); // 288, интервал мониторинга — 5 минут

  const days = [];
  let okSum = 0;
  let totalSum = 0;
  let daysWithData = 0;
  for (let i = UPTIME_DAYS - 1; i >= 0; i--) {
    const key = dayKeyFmt.format(new Date(Date.now() - i * 86400000));
    const d = byDay.get(key);
    let status = null; // нет данных за этот день
    if (d && d.total > 0) {
      okSum += d.ok;
      totalSum += d.total;
      daysWithData++;
      if (d.ok === d.total) status = 'ok';
      else if (d.ok === 0) status = 'major';
      else status = 'degraded';
    } else {
      // День без данных — засчитываем как полностью нормальный
      okSum += ASSUMED_CHECKS_PER_DAY;
      totalSum += ASSUMED_CHECKS_PER_DAY;
    }
    days.push({ date: key, status });
  }

  const uptimePct = daysWithData === 0 ? null : Math.round((okSum / totalSum) * 10000) / 100;
  return { days, uptimePct, daysWithData };
}

function serviceToClient(s, uptime, latestLatencyMs) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    status: s.status,
    manualOverride: s.manual_override,
    hasCheckUrl: !!s.check_url || s.check_type === 'telegram_webhook',
    uptimePct: uptime.uptimePct,
    daysWithData: uptime.daysWithData,
    latencyMs: latestLatencyMs,
    days: uptime.days,
  };
}

// Время ответа последней успешной проверки — просто для информации рядом со статусом
async function latestLatency(serviceId) {
  const { rows } = await pool.query(
    `SELECT latency_ms FROM status_checks WHERE service_id = $1 AND ok = TRUE
     ORDER BY checked_at DESC LIMIT 1`,
    [serviceId]
  );
  return rows[0]?.latency_ms ?? null;
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
    scheduledAt: i.scheduled_at,
    // группа для фронта: активное сейчас / запланировано на будущее / история (закрыто)
    group: i.status === 'resolved'
      ? 'history'
      : (i.scheduled_at && new Date(i.scheduled_at) > new Date() ? 'scheduled' : 'active'),
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
      services.map(async (s) => serviceToClient(s, await buildUptime(s.id), await latestLatency(s.id)))
    );

    const incidents = await incidentsWithUpdates();

    const worst = withUptime.reduce((acc, s) => {
      const rank = { ok: 0, degraded: 1, maint: 1, partial: 2, major: 3 };
      return (rank[s.status] || 0) > (rank[acc] || 0) ? s.status : acc;
    }, 'ok');

    // Отдаём имена затронутых сервисов отдельно — на фронте формулировка баннера
    // должна отличаться для "не работает один сервис" и "проблемы массово",
    // а не всегда писать "серьёзные перебои" из-за одного упавшего.
    const affectedServiceNames = withUptime.filter((s) => s.status !== 'ok').map((s) => s.name);

    res.json({
      overall: worst,
      affectedServiceNames,
      services: withUptime,
      incidents,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/status error:', err);
    res.status(500).json({ error: 'Не удалось получить статус' });
  }
});

// ── GET /api/status/feed.xml ── публичное, RSS-фид инцидентов ──
// Та же самая история инцидентов, что и на странице, просто в формате, который
// понимают читалки фидов (Feedly и т.п.) — альтернатива email-подписке. Данные
// уже загружены на каждый обычный визит страницы, здесь просто другая обёртка —
// заметной нагрузки не добавляет.
function xmlEscape(s) {
  return String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

const incidentBadgeLabelsServer = {
  investigating: 'Расследуем', identified: 'Причина найдена',
  monitoring: 'Наблюдаем', resolved: 'Устранено',
};

router.get('/feed.xml', async (req, res) => {
  try {
    const incidents = await incidentsWithUpdates(50);
    const items = incidents.map((inc) => {
      const lastUpdate = inc.updates[inc.updates.length - 1];
      const link = 'https://antviz.ru/status.html';
      return `
    <item>
      <title>${xmlEscape(inc.title)}${inc.serviceName ? ` — ${xmlEscape(inc.serviceName)}` : ''} (${xmlEscape(incidentBadgeLabelsServer[inc.status] || inc.status)})</title>
      <link>${link}</link>
      <guid isPermaLink="false">${inc.id}</guid>
      <pubDate>${new Date(lastUpdate ? lastUpdate.createdAt : inc.createdAt).toUTCString()}</pubDate>
      <description>${xmlEscape(inc.updates.map((u) => u.message).join(' | '))}</description>
    </item>`;
    }).join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Antviz — статус сервисов</title>
    <link>https://antviz.ru/status.html</link>
    <description>Инциденты и обновления статуса сервисов Antviz</description>
    <language>ru</language>${items}
  </channel>
</rss>`;

    res.set('Content-Type', 'application/rss+xml; charset=utf-8');
    res.send(xml);
  } catch (err) {
    console.error('GET /api/status/feed.xml error:', err);
    res.status(500).send('Не удалось сформировать фид');
  }
});

// ── POST /api/status/subscribe ── публичное, подписка на уведомления ──
router.post('/subscribe', subscribeLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Введите корректный email' });
    if (isDisposableEmail(email)) {
      return res.status(400).json({ error: 'Временные (одноразовые) email не поддерживаются, укажите постоянный адрес' });
    }

    const captchaOk = await verifyTurnstile(req.body?.cfToken);
    if (!captchaOk) return res.status(400).json({ error: 'Не пройдена проверка капчи, попробуйте ещё раз' });

    // Уже подписан — не шлём письмо повторно и не трогаем токен отписки,
    // просто говорим об этом честно, отдельным сообщением.
    const existing = await pool.query('SELECT id FROM status_subscribers WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.json({ ok: true, alreadySubscribed: true });
    }

    const token = crypto.randomBytes(24).toString('hex');
    await pool.query(
      `INSERT INTO status_subscribers (email, unsubscribe_token) VALUES ($1,$2)`,
      [email, token]
    );
    const unsubscribeUrl = `https://antviz.ru/api/status/unsubscribe/${token}`;

    sendStatusSubscribedEmail(email, unsubscribeUrl).catch((err) =>
      console.error('sendStatusSubscribedEmail error:', err)
    );

    res.json({ ok: true, alreadySubscribed: false });
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
    const type = ['http', 'telegram_webhook', 'github_status'].includes(checkType) ? checkType : 'http';

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
      if (!['http', 'telegram_webhook', 'github_status'].includes(checkType)) return res.status(400).json({ error: 'Некорректный check_type' });
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

    // Меняется URL или тип проверки — старая история проверок относится к другому
    // способу проверки и больше не отражает реальность нового. Чтобы % аптайма не
    // мешал старые (возможно ошибочные) данные с новыми — чистим историю при смене.
    const changingCheckMethod = checkUrl !== undefined || checkType !== undefined;
    if (changingCheckMethod) {
      await pool.query('DELETE FROM status_checks WHERE service_id = $1', [req.params.id]);
    }

    values.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE status_services SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Сервис не найден' });

    // Сняли ручную фиксацию ИЛИ поменяли способ проверки (URL/тип/заголовки) — в обоих
    // случаях сразу гоняем реальную проверку вместо того чтобы ждать до 5 минут
    // (следующий плановый цикл монитора). Раньше выглядело так, будто данные не
    // совпадают с реальностью — статус уже "ok", а % аптайма ещё старый.
    const needsInstantRecheck = manualOverride === false || checkUrl !== undefined || checkType !== undefined || checkHeaders !== undefined;
    if (needsInstantRecheck) {
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

// ── DELETE /api/status/services/:id/checks?date=YYYY-MM-DD ── очистить историю
// проверок сервиса за один конкретный день (по московскому времени) — например,
// если день покрашен жёлтым/красным из-за ошибки в настройках мониторинга, а не
// реального сбоя. После очистки день становится "нет данных" и на графике снова
// зелёный (дни без данных не считаются проблемой).
router.delete('/services/:id/checks', requireAdmin, async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Нужна дата в формате YYYY-MM-DD' });
  }
  const { rowCount } = await pool.query(
    `DELETE FROM status_checks
     WHERE service_id = $1 AND (checked_at AT TIME ZONE '${TIMEZONE}')::date = $2::date`,
    [req.params.id, date]
  );
  res.json({ ok: true, deleted: rowCount });
});

// Рассылка подписчикам — общая функция, см. lib/statusNotify.js
// ── POST /api/status/incidents ── создать инцидент (+ первая запись таймлайна) ──
router.post('/incidents', requireAdmin, async (req, res) => {
  try {
    const { title, severity, serviceId, message, scheduledAt } = req.body || {};
    if (!title || !message) return res.status(400).json({ error: 'Заполните заголовок и описание' });
    if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Некорректная серьёзность' });

    let scheduledDate = null;
    if (scheduledAt) {
      scheduledDate = new Date(scheduledAt);
      if (isNaN(scheduledDate.getTime())) return res.status(400).json({ error: 'Некорректная дата' });
    }
    const isFuturePlan = scheduledDate && scheduledDate > new Date();

    const { rows: incRows } = await pool.query(
      `INSERT INTO status_incidents (service_id, title, severity, status, created_by, scheduled_at)
       VALUES ($1,$2,$3,'investigating',$4,$5) RETURNING *`,
      [serviceId || null, title, severity, req.user.email, scheduledDate]
    );
    const incident = incRows[0];

    await pool.query(
      `INSERT INTO status_incident_updates (incident_id, status, message, created_by)
       VALUES ($1,'investigating',$2,$3)`,
      [incident.id, message, req.user.email]
    );

    // Пока инцидент открыт — статус сервиса подсвечивается его severity (если не override).
    // Если это запланированные работы на будущее — статус сервиса пока НЕ трогаем,
    // он появится в разделе "Запланировано", а не как активная проблема прямо сейчас.
    if (serviceId && !isFuturePlan) {
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

// ════════════════════════════════════════════════════════════
// Диагностика сети сервера — админ-инструмент, не публичная часть
// статус-страницы. Показывает: публичный IP сервера (+ провайдер, город),
// пинг до нескольких надёжных точек (чтобы отличить "у меня проблема с
// конкретным сервисом" от "у сервера вообще проблемы с интернетом"),
// и тест скорости по запросу.
// ════════════════════════════════════════════════════════════

const DIAG_TARGETS = [
  { name: 'Cloudflare', url: 'https://www.cloudflare.com/cdn-cgi/trace' },
  { name: 'Google', url: 'https://www.google.com/generate_204' },
  { name: 'Яндекс', url: 'https://ya.ru/' },
  { name: 'GitHub', url: 'https://github.com/' },
  { name: 'Telegram API', url: 'https://api.telegram.org/' },
];

async function pingOne(url) {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: true, ms: Date.now() - started, statusCode: resp.status };
  } catch (err) {
    return { ok: false, ms: Date.now() - started, error: String(err?.message || err) };
  }
}

// ── GET /api/status/diagnostics ── IP сервера + пинг до контрольных точек ──
router.get('/diagnostics', requireAdmin, async (req, res) => {
  try {
    let ipInfo = null;
    try {
      const ipResp = await fetch('http://ip-api.com/json/?fields=query,country,city,isp,org,as');
      ipInfo = await ipResp.json();
    } catch (err) {
      console.error('diagnostics: не удалось получить IP сервера:', err);
    }

    const pings = await Promise.all(
      DIAG_TARGETS.map(async (t) => ({ name: t.name, ...(await pingOne(t.url)) }))
    );

    const { rows: subRows } = await pool.query('SELECT count(*)::int AS n FROM status_subscribers');

    res.json({ ip: ipInfo, pings, subscriberCount: subRows[0].n });
  } catch (err) {
    console.error('GET /api/status/diagnostics error:', err);
    res.status(500).json({ error: 'Не удалось получить диагностику' });
  }
});

// ── GET /api/status/diagnostics/speedtest ── тест скорости, по запросу (медленный) ──
router.get('/diagnostics/speedtest', requireAdmin, async (req, res) => {
  try {
    const bytes = 15 * 1000 * 1000; // 15 МБ — компромисс между точностью и временем ожидания
    const started = Date.now();
    const resp = await fetch(`https://speed.cloudflare.com/__down?bytes=${bytes}`);
    const buf = await resp.arrayBuffer();
    const seconds = (Date.now() - started) / 1000;
    const mbps = Math.round(((buf.byteLength * 8) / 1_000_000 / seconds) * 100) / 100;
    res.json({ mbps, bytesLoaded: buf.byteLength, seconds: Math.round(seconds * 100) / 100 });
  } catch (err) {
    console.error('GET /api/status/diagnostics/speedtest error:', err);
    res.status(500).json({ error: 'Не удалось выполнить тест скорости' });
  }
});

module.exports = router;
