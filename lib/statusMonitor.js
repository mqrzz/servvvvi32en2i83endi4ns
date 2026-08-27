// lib/statusMonitor.js
//
// Реальная самопроверка сервисов для страницы статуса: раз в CHECK_INTERVAL_MS
// проверяем каждый сервис из status_services и пишем результат в status_checks
// (для % аптайма и дневных полосок), плюс обновляем status_services.status —
// 'ok' если проверка прошла, иначе 'major'.
//
// Два вида проверки (поле check_type):
//   'http'             — обычный GET по check_url, ожидаем 2xx/3xx. check_headers
//                         (JSONB) добавляются к запросу — нужно, например, для
//                         Vercel Deployment Protection Bypass на платёжном сервисе.
//   'telegram_webhook' — для бота: НЕ ходим на его домен вообще, а спрашиваем
//                         у самого Telegram (getWebhookInfo), доставляются ли ему
//                         апдейты без ошибок. Требует TELEGRAM_BOT_TOKEN в .env
//                         этого (бэкенд) процесса — тот же токен, что зашит в
//                         переменных окружения самого бота на Vercel.
//
// Если у сервиса выставлен manual_override — монитор его не трогает: статус
// управляется вручную из админки (например на время техработ, или пока не
// настроена автопроверка — как было с ботом/платежами до этого коммита).
//
// Требует Node >= 18 (глобальный fetch).

const pool = require('../db/pool');
const { notifySubscribers } = require('./statusNotify');

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // раз в 5 минут
const CHECK_TIMEOUT_MS = 8000;
// Если Telegram не доставлял апдейты дольше этого — считаем, что вебхук не в порядке
const TELEGRAM_STALE_ERROR_MS = 10 * 60 * 1000;

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
    // Нет обработанного вебхука вообще — точно что-то не так
    if (!info.url) return { ok: false, error: 'webhook не установлен', latencyMs };

    // last_error_date есть и он свежий — Telegram не может доставить апдейты
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

// Проверка статуса GitHub через их же публичный status-JSON (githubstatus.com):
// HTTP-код там всегда 200 даже во время их сбоев — реальный статус зашит в тело
// ответа (status.indicator), поэтому смотрим именно на него, а не на код ответа.
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

    const indicator = data.status.indicator; // 'none' | 'minor' | 'major' | 'critical'
    // 'minor' — это реально жёлтый (частичная деградация), а не полный сбой.
    // 'major'/'critical' — уже настоящий недоступен.
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
    return; // нет способа проверить — статус только вручную
  }

  await pool.query(
    `INSERT INTO status_checks (service_id, ok, status_code, latency_ms, error)
     VALUES ($1,$2,$3,$4,$5)`,
    [service.id, result.ok, result.statusCode || null, result.latencyMs || null, result.error || null]
  );

  if (!service.manual_override) {
    const newStatus = result.ok ? 'ok' : (result.severity || 'major');
    if (newStatus !== service.status) {
      await pool.query('UPDATE status_services SET status = $1 WHERE id = $2', [newStatus, service.id]);
      await handleAutoIncident(service, newStatus, result.error);
    }
  }
}

// ── Автоматические инциденты ──
// Когда сервис реально падает (по автопроверке) — заводим инцидент и пишем первую
// запись сами. Когда восстанавливается — сами же закрываем записью "Устранено".
// Админ может в любой момент зайти и дописать что угодно поверх — это обычный
// инцидент, ничем не отличается от заведённого вручную.
async function handleAutoIncident(service, newStatus, errorDetail) {
  try {
    if (newStatus !== 'ok') {
      // Сервис упал — если для него уже есть открытый инцидент, не плодим второй
      const { rows: open } = await pool.query(
        `SELECT id FROM status_incidents WHERE service_id = $1 AND status != 'resolved'`,
        [service.id]
      );
      if (open.length > 0) return;

      const message = `Автопроверка перестала получать успешный ответ от сервиса «${service.name}»${errorDetail ? ` (${errorDetail})` : ''}. Разбираемся.`;
      const { rows: incRows } = await pool.query(
        `INSERT INTO status_incidents (service_id, title, severity, status, created_by)
         VALUES ($1,$2,$3,'investigating','auto') RETURNING *`,
        [service.id, `Автоматически обнаружен сбой: ${service.name}`, newStatus]
      );
      await pool.query(
        `INSERT INTO status_incident_updates (incident_id, status, message, created_by)
         VALUES ($1,'investigating',$2,'auto')`,
        [incRows[0].id, message]
      );
      await notifySubscribers({ incidentTitle: incRows[0].title, status: 'investigating', message });
    } else {
      // Сервис восстановился — закрываем автоматически заведённые инциденты по нему
      const { rows: open } = await pool.query(
        `SELECT * FROM status_incidents WHERE service_id = $1 AND status != 'resolved' AND created_by = 'auto'`,
        [service.id]
      );
      for (const incident of open) {
        const message = `Автопроверка снова получает успешный ответ от «${service.name}». Инцидент закрыт автоматически.`;
        await pool.query(
          `INSERT INTO status_incident_updates (incident_id, status, message, created_by) VALUES ($1,'resolved',$2,'auto')`,
          [incident.id, message]
        );
        await pool.query(`UPDATE status_incidents SET status = 'resolved', resolved_at = now() WHERE id = $1`, [incident.id]);
        await notifySubscribers({ incidentTitle: incident.title, status: 'resolved', message });
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

// Мгновенная проверка ОДНОГО сервиса по id — вызывается из PATCH /api/status/services/:id,
// когда с сервиса снимают manual_override, чтобы статус на странице обновился сразу,
// а не ждал следующего планового цикла (до CHECK_INTERVAL_MS).
async function checkService(id) {
  const { rows } = await pool.query('SELECT * FROM status_services WHERE id = $1', [id]);
  if (rows.length === 0) return;
  await checkOne(rows[0]);
}

function start() {
  // Первая проверка — сразу при старте сервера, дальше по интервалу
  runChecks().catch((err) => console.error('statusMonitor: ошибка первого запуска:', err));
  setInterval(() => {
    runChecks().catch((err) => console.error('statusMonitor: ошибка планового запуска:', err));
  }, CHECK_INTERVAL_MS);
}

module.exports = { start, runChecks, checkService };
