// Единая доставка уведомлений пользователю:
//   1) запись в кабинет (колокольчик) — всегда, отключить нельзя;
//   2) Telegram — если привязан бот И в настройках пользователя включён этот тип;
//   3) e-mail — только если пользователь сам включил этот тип в настройках.
//
// Раньше эта логика была размазана: routes/notifications.js (рассылка) и
// utils/subscriptionReminders.js по-своему вставляли строки и по-своему дёргали
// Telegram. Теперь оба используют deliverNotifications() отсюда.
const pool = require('../db/pool');
const { pruneOldNotifications } = require('./notifications');
const { notifyTelegram } = require('./notifyTelegram');
const { sendNotificationEmail } = require('./mailer');

const TYPES = ['order', 'support', 'service', 'system'];
// По умолчанию — как было до появления настроек: Telegram шлём, письма — нет.
const DEFAULT_CHANNELS = { telegram: true, email: false };

const DEFAULT_LINKS = {
  order: '/profile/orders',
  support: '/profile/support',
  service: '/profile/tickets',
  system: '/profile/notifications',
};

function normalizePrefs(raw) {
  const out = {};
  for (const t of TYPES) {
    const src = (raw && raw[t]) || {};
    out[t] = {
      telegram: typeof src.telegram === 'boolean' ? src.telegram : DEFAULT_CHANNELS.telegram,
      email: typeof src.email === 'boolean' ? src.email : DEFAULT_CHANNELS.email,
    };
  }
  return out;
}

// Если вызывающий не передал type (например, старые кнопки в админке) —
// определяем по ссылке кнопки, а затем по словам в заголовке.
function inferType({ type, title, text, buttonUrl, link }) {
  if (TYPES.includes(type)) return type;
  const url = String(link || buttonUrl || '');
  if (/\/profile\/support/.test(url)) return 'support';
  if (/\/profile\/tickets/.test(url)) return 'service';
  if (/\/profile\/orders|\/order(\b|\/|\?)/.test(url)) return 'order';
  const s = `${title || ''} ${text || ''}`.toLowerCase();
  if (/обслуживан|заявк[аиу] на|доработк|правк[аиу] по заявк/.test(s)) return 'service';
  if (/поддержк|тикет|ответ/.test(s)) return 'support';
  if (/заказ|оплат|статус|готов/.test(s)) return 'order';
  return 'system';
}

// Ссылка внутри сайта: https://antviz.ru/profile/orders.html?id=1 -> /profile/orders?id=1
function toInternalPath(url) {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://antviz.ru');
    if (u.hostname !== 'antviz.ru' && u.hostname !== 'www.antviz.ru') return null;
    return (u.pathname.replace(/\.html$/, '') || '/') + u.search;
  } catch (e) {
    return null;
  }
}

async function loadPrefs(userIds) {
  const map = new Map();
  if (!userIds.length) return map;
  const { rows } = await pool.query(
    'SELECT user_id, prefs FROM notification_prefs WHERE user_id = ANY($1::uuid[])',
    [userIds]
  );
  rows.forEach((r) => map.set(r.user_id, normalizePrefs(r.prefs)));
  return map;
}

async function getUserPrefs(userId) {
  const map = await loadPrefs([userId]);
  return map.get(userId) || normalizePrefs(null);
}

async function saveUserPrefs(userId, rawPrefs) {
  const prefs = normalizePrefs(rawPrefs);
  await pool.query(
    `INSERT INTO notification_prefs (user_id, prefs, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [userId, JSON.stringify(prefs)]
  );
  return prefs;
}

// userIds — массив id; payload — { title, text, type?, link?, buttonText?, buttonUrl? }
async function deliverNotifications(userIds, payload) {
  const { title, text, buttonText, buttonUrl } = payload;
  if (!userIds.length) return { sent: 0 };

  const type = inferType(payload);
  const link = payload.link || toInternalPath(buttonUrl) || DEFAULT_LINKS[type];

  const values = userIds.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(',');
  const params = userIds.flatMap((id) => [id, title, text || null, type, link]);
  await pool.query(`INSERT INTO notifications (user_id, title, text, type, link) VALUES ${values}`, params);
  await Promise.all(userIds.map((id) => pruneOldNotifications(id).catch((e) => console.error('pruneOldNotifications:', e))));

  // Дальше — «приятный бонус»: ошибки каналов не должны ронять основное действие.
  let prefsMap = new Map();
  try {
    prefsMap = await loadPrefs(userIds);
  } catch (e) {
    console.error('deliverNotifications: не удалось прочитать настройки, беру значения по умолчанию:', e);
  }

  const emailIds = [];
  userIds.forEach((uid) => {
    const p = (prefsMap.get(uid) || normalizePrefs(null))[type];
    if (p.telegram) {
      notifyTelegram(uid, {
        title, text,
        buttonText: buttonText || 'Открыть',
        buttonUrl: buttonUrl || `https://antviz.ru${link}`,
      });
    }
    if (p.email) emailIds.push(uid);
  });

  if (emailIds.length) {
    try {
      const { rows } = await pool.query('SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [emailIds]);
      rows.forEach((u) => {
        sendNotificationEmail(u.email, {
          title, text,
          buttonText: buttonText || 'Открыть в кабинете',
          buttonUrl: buttonUrl || `https://antviz.ru${link}`,
        }).catch((e) => console.error('sendNotificationEmail:', u.id, e));
      });
    } catch (e) {
      console.error('deliverNotifications: e-mail:', e);
    }
  }

  return { sent: userIds.length };
}

module.exports = {
  TYPES, DEFAULT_LINKS, normalizePrefs, inferType, toInternalPath,
  getUserPrefs, saveUserPrefs, deliverNotifications,
};
