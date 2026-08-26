const pool = require('../db/pool');
const crypto = require('crypto');

const BOT_NOTIFY_URL = process.env.BOT_NOTIFY_URL || 'https://3ssqztgbot22wsq.vercel.app/api/notify';

// Не блокирует основной запрос и не роняет его, если бот недоступен —
// уведомление в Telegram это "приятный бонус", а не критичная часть
// самого действия (ответ в поддержке / создание уведомления должны
// сохраниться в любом случае, даже если Vercel-бот сейчас недоступен).
//
// buttonUrl, если передан, должен вести на страницу, куда нужно ПОПАСТЬ
// УЖЕ ВОЙДЯ — поэтому оборачиваем его в одноразовый код входа через
// tg-enter.html (та же таблица bot_tokens, что использует сам бот; тут
// её не нужно спрашивать через HTTP, бэкенд и так на ней сидит).
async function notifyTelegram(userId, { title, text, buttonText, buttonUrl } = {}) {
  try {
    const { rows } = await pool.query('SELECT telegram_id FROM users WHERE id = $1', [userId]);
    const chatId = rows[0]?.telegram_id;
    if (!chatId) return; // юзер не привязал Telegram — это нормально, не ошибка

    let finalButtonUrl = null;
    if (buttonText && buttonUrl) {
      const code = crypto.randomUUID();
      await pool.query(
        `INSERT INTO bot_tokens (token, user_id, purpose, expires_at) VALUES ($1,$2,'app_auth',$3)`,
        [code, userId, new Date(Date.now() + 3 * 60 * 1000)]
      );
      finalButtonUrl = `https://antviz.ru/tg-enter.html?t=${code}&to=${encodeURIComponent(buttonUrl)}`;
    }

    await fetch(BOT_NOTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Secret': process.env.BOT_API_SECRET },
      body: JSON.stringify({
        chatId, title, text,
        buttonText: finalButtonUrl ? buttonText : undefined,
        buttonUrl: finalButtonUrl,
        buttonWebApp: true,
      }),
    });
  } catch (err) {
    console.error('notifyTelegram failed for user', userId, err);
  }
}

module.exports = { notifyTelegram };
