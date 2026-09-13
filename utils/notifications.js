// Раньше уведомления копились бесконечно (GET отдавал последние 100, но
// сами старые записи никогда не удалялись — таблица только росла). Теперь
// после каждой вставки уведомления для юзера обрезаем его историю до
// последних N штук — реальное удаление из БД, не просто "не показываем"
// на фронте.
const pool = require('../db/pool');

const KEEP_LAST = 10;

async function pruneOldNotifications(userId) {
  await pool.query(
    `DELETE FROM notifications
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
    [userId, KEEP_LAST]
  );
}

module.exports = { pruneOldNotifications, KEEP_LAST };
