const pool = require('../db/pool');
const crypto = require('crypto');

const BOT_NOTIFY_URL = process.env.BOT_NOTIFY_URL || 'https://3ssqztgbot22wsq.vercel.app/api/notify';

async function notifyTelegram(userId, { title, text, buttonText, buttonUrl } = {}) {
  try {
    const { rows } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
    const chatId = rows[0]?.telegram_id;
    if (!chatId) return;

    let finalButtonUrl = null;
    if (buttonText && buttonUrl) {
      const code = crypto.randomUUID();
      await pool.query(
        `INSERT INTO bot_tokens (token, user_id, purpose, expires_at) VALUES ($1,$2,'app_auth',$3)`,
        [code, userId, new Date(Date.now() + 3 * 60 * 1000)]
      );
      finalButtonUrl = `https://antviz.ru/tg-enter.html?t=${code}&to=${encodeURIComponent(buttonUrl)}`;
    }

    if (!process.env.BOT_API_SECRET) {
      console.error('notifyTelegram: BOT_API_SECRET не задан на бэкенде — сообщение НЕ будет доставлено боту');
    }

    const resp = await fetch(BOT_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_API_SECRET },
      body: JSON.stringify({
        chatId, title, text,
        buttonText: finalButtonUrl ? buttonText : undefined,
        buttonUrl: finalButtonUrl,
        buttonWebApp: true,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('notifyTelegram: бот вернул ошибку', resp.status, body, 'для пользователя', userId);
    }
  } catch (err) {
    console.error('notifyTelegram failed for user', userId, err);
  }
}

module.exports = { notifyTelegram };
