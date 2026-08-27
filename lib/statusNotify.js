// lib/statusNotify.js
//
// Рассылка обновлений подписчикам статус-страницы. Вынесено в отдельный модуль,
// потому что нужна и в routes/status.js (ручные инциденты), и в lib/statusMonitor.js
// (автоматические инциденты при падении/восстановлении сервиса).

const pool = require('../db/pool');
const { sendIncidentUpdateEmail } = require('../utils/mailer');

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

module.exports = { notifySubscribers };
