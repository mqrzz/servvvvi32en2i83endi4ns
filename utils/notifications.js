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
