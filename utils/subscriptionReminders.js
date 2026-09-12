// П.9: уведомление об истечении обслуживания — раньше такого не было вообще,
// человек узнавал, что подписка кончилась, только когда упирался в лимит
// заявок или когда пытался открыть "Обслуживание" и видел "нужно продлить".
// Проверяем раз в несколько часов все активные подписки, которые истекают
// в течение 3 дней и ещё не получали напоминание в ЭТОМ периоде — создаём
// обычное уведомление в личном кабинете + дублируем в Telegram, если бот
// у пользователя подключён (notifyTelegram сама тихо пропускает тех, у
// кого Telegram не привязан — это не ошибка).
const pool = require('../db/pool');
const { notifyTelegram } = require('./notifyTelegram');

const WARNING_WINDOW_DAYS = 3;

async function checkExpiringSubscriptions() {
  let rows;
  try {
    ({ rows } = await pool.query(
      `SELECT s.id, s.user_id, s.period_end, s.tariff, o.site_domain, o.id as order_id
       FROM service_subscriptions s
       JOIN orders o ON o.id = s.order_id
       WHERE s.status = 'active'
         AND s.period_end > now()
         AND s.period_end <= now() + interval '${WARNING_WINDOW_DAYS} days'
         AND (s.expiry_notified_at IS NULL OR s.expiry_notified_at < s.period_start)`
    ));
  } catch (err) {
    console.error('checkExpiringSubscriptions: ошибка выборки подписок:', err);
    return;
  }

  for (const s of rows) {
    const daysLeft = Math.max(1, Math.ceil((new Date(s.period_end) - new Date()) / (24 * 60 * 60 * 1000)));
    const label = s.site_domain || `заказ №${s.order_id.slice(0, 7).toUpperCase()}`;
    const title = '⏳ Обслуживание скоро закончится';
    const text = `Подписка на обслуживание для ${label} истекает через ${daysLeft} ${daysLeft === 1 ? 'день' : 'дн.'}. Продлите заранее, чтобы не потерять лимит заявок на доработки.`;

    try {
      await pool.query(
        'INSERT INTO notifications (user_id, title, text) VALUES ($1,$2,$3)',
        [s.user_id, title, text]
      );
      await pool.query(
        'UPDATE service_subscriptions SET expiry_notified_at = now() WHERE id = $1',
        [s.id]
      );
      notifyTelegram(s.user_id, {
        title, text,
        buttonText: 'Продлить',
        buttonUrl: 'https://antviz.ru/profile/tickets.html',
      });
    } catch (err) {
      console.error('checkExpiringSubscriptions: не удалось уведомить по подписке', s.id, err);
    }
  }
}

module.exports = { checkExpiringSubscriptions };
