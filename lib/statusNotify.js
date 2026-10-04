
const pool = require('../db/pool');
const { sendIncidentUpdateEmail } = require('../utils/mailer');

async function notifySubscribers({ incidentTitle, status, message }) {
  const { rows: subs } = await pool.query('SELECT email, unsubscribe_token FROM status_subscribers WHERE confirmed_at IS NOT NULL');
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

async function ensureStatusSubscriberColumns() {
  try {
    await pool.query(`
      ALTER TABLE status_subscribers ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
      ALTER TABLE status_subscribers ADD COLUMN IF NOT EXISTS confirm_token TEXT;
      UPDATE status_subscribers SET confirmed_at = COALESCE(created_at, now()) WHERE confirmed_at IS NULL AND confirm_token IS NULL;
    `);
  } catch (err) {
    console.error('status_subscribers: не удалось обновить таблицу:', err.message);
  }
}

module.exports = { notifySubscribers, ensureStatusSubscriberColumns };
