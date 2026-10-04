
const pool = require('../db/pool');
const { notifySubscribers } = require('./statusNotify');

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;
const LATENCY_DEGRADED_MS = 5000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECKS_RETENTION_DAYS = 90;
const TELEGRAM_STALE_ERROR_MS = 10 * 60 * 1000;
const CONFIRM_CHECKS = 2;
const pendingFlips = new Map();

async function checkHttp(service) {
  if (!service.check_url) return { ok: false, error: 'нет check_url' };

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const resp = await fetch(service.check_url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: service.check_headers || undefined,
    });
    clearTimeout(timer);
    return {
      ok: resp.status >= 200 && resp.status < 400,
      statusCode: resp.status,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), latencyMs: Date.now() - started };
  }
}

async function checkTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN не задан на бэкенде' };

  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const resp = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: controller.signal });
    clearTimeout(timer);
    const data = await resp.json();
    const latencyMs = Date.now() - started;

    if (!resp.ok || !data.ok) return { ok: false, error: 'Telegram API вернул ошибку', latencyMs, statusCode: resp.status };

    const info = data.result;
    if (!info.url) return { ok: false, error: 'webhook не установлен', latencyMs };

    if (info.last_error_date) {
      const ageMs = Date.now() - info.last_error_date * 1000;
      if (ageMs < TELEGRAM_STALE_ERROR_MS) {
        return { ok: false, error: info.last_error_message || 'свежая ошибка доставки вебхука', latencyMs };
      }
    }
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), latencyMs: Date.now() - started };
  }
}

async function checkGithubStatus() {
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
    const resp = await fetch('https://www.githubstatus.com/api/v2/status.json', { signal: controller.signal });
    clearTimeout(timer);
    const data = await resp.json();
    const latencyMs = Date.now() - started;

    if (!resp.ok || !data?.status?.indicator) {
      return { ok: false, error: 'githubstatus.com вернул неожиданный ответ', latencyMs, statusCode: resp.status };
    }

    const indicator = data.status.indicator;
    const severity = indicator === 'minor' ? 'degraded' : indicator === 'none' ? null : 'major';
    return { ok: indicator === 'none', severity, error: indicator !== 'none' ? data.status.description : null, latencyMs };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), latencyMs: Date.now() - started };
  }
}

async function checkOne(service) {
  let result;
  if (service.check_type === 'telegram_webhook') {
    result = await checkTelegramWebhook();
  } else if (service.check_type === 'github_status') {
    result = await checkGithubStatus();
  } else if (service.check_url) {
    result = await checkHttp(service);
  } else {
    return;
  }

  await pool.query(
    `INSERT INTO status_checks (service_id, ok, status_code, latency_ms, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [service.id, result.ok, result.statusCode || null, result.latencyMs || null, result.error || null]
  );

  if (!service.manual_override) {
    let candidateStatus;
    if (!result.ok) candidateStatus = result.severity || 'major';
    else if (result.latencyMs && result.latencyMs > LATENCY_DEGRADED_MS) candidateStatus = 'degraded';
    else candidateStatus = 'ok';

    if (candidateStatus === service.status) {
      pendingFlips.delete(service.id);
    } else {
      const pending = pendingFlips.get(service.id);
      const count = (pending && pending.status === candidateStatus) ? pending.count + 1 : 1;
      if (count >= CONFIRM_CHECKS) {
        pendingFlips.delete(service.id);
        await pool.query('UPDATE status_services SET status = $1 WHERE id = $2', [candidateStatus, service.id]);
        await handleAutoIncident(service, candidateStatus, result.error);
      } else {
        pendingFlips.set(service.id, { status: candidateStatus, count });
      }
    }
  }
}

async function handleAutoIncident(service, newStatus, errorDetail) {
  try {
    if (newStatus !== 'ok') {
      const { rows: open } = await pool.query(
        `SELECT id FROM status_incidents WHERE service_id = $1 AND status != 'resolved'`,
        [service.id]
      );
      if (open.length > 0) return;

      const title = newStatus === 'degraded' && !errorDetail
        ? 'Замедление в работе'
        : 'Автоматически обнаружен сбой';
      const message = newStatus === 'degraded' && !errorDetail
        ? `Автопроверка фиксирует, что сервис отвечает медленнее обычного. Разбираемся.`
        : `Автопроверка перестала получать успешный ответ от сервиса${errorDetail ? ` (${errorDetail})` : ''}. Разбираемся.`;
      const { rows: incRows } = await pool.query(
        `INSERT INTO status_incidents (service_id, title, severity, status, created_by)
         VALUES ($1,$2,$3,'investigating','auto') RETURNING *`,
        [service.id, title, newStatus]
      );
      await pool.query(
        `INSERT INTO status_incident_updates (incident_id, status, message, created_by)
         VALUES ($1,'investigating',$2,'auto')`,
        [incRows[0].id, message]
      );
      await notifySubscribers({ incidentTitle: `${title} — ${service.name}`, status: 'investigating', message });
    } else {
      const { rows: open } = await pool.query(
        `SELECT * FROM status_incidents WHERE service_id = $1 AND status != 'resolved' AND created_by = 'auto'`,
        [service.id]
      );
      for (const incident of open) {
        const message = `Автопроверка снова получает успешный ответ от сервиса. Инцидент закрыт автоматически.`;
        await pool.query(
          `INSERT INTO status_incident_updates (incident_id, status, message, created_by) VALUES ($1,'resolved',$2,'auto')`,
          [incident.id, message]
        );
        await pool.query(`UPDATE status_incidents SET status = 'resolved', resolved_at = now() WHERE id = $1`, [incident.id]);
        await notifySubscribers({ incidentTitle: `${incident.title} — ${service.name}`, status: 'resolved', message });
      }
    }
  } catch (err) {
    console.error('statusMonitor: не удалось обработать автоинцидент:', err);
  }
}

async function runChecks() {
  let services;
  try {
    ({ rows: services } = await pool.query('SELECT * FROM status_services ORDER BY sort_order'));
  } catch (err) {
    console.error('statusMonitor: не удалось получить список сервисов:', err);
    return;
  }

  await Promise.all(
    services.map((s) =>
      checkOne(s).catch((err) => console.error(`statusMonitor: ошибка проверки "${s.name}":`, err))
    )
  );
}

async function checkService(id) {
  const { rows } = await pool.query('SELECT * FROM status_services WHERE id = $1', [id]);
  if (rows.length === 0) return;
  await checkOne(rows[0]);
}

async function cleanupOldChecks() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM status_checks WHERE checked_at < now() - interval '${CHECKS_RETENTION_DAYS} days'`
    );
    if (rowCount > 0) console.log(`statusMonitor: очищено ${rowCount} старых записей проверок (>${CHECKS_RETENTION_DAYS} дней)`);
  } catch (err) {
    console.error('statusMonitor: не удалось очистить старую историю проверок:', err);
  }
}

function start() {
  runChecks().catch((err) => console.error('statusMonitor: ошибка первого запуска:', err));
  setInterval(() => {
    runChecks().catch((err) => console.error('statusMonitor: ошибка планового запуска:', err));
  }, CHECK_INTERVAL_MS);

  cleanupOldChecks();
  setInterval(cleanupOldChecks, CLEANUP_INTERVAL_MS);
}

module.exports = { start, runChecks, checkService };
