const pool = require('../db/pool');

const RETENTION_MONTHS = 2;

async function cleanupOldSupportEmails() {
  let result;
  try {
    result = await pool.query(
      `DELETE FROM support_emails WHERE created_at < now() - interval '${RETENTION_MONTHS} months'`
    );
  } catch (err) {
    console.error('cleanupOldSupportEmails: ошибка удаления:', err);
    return;
  }
  if (result.rowCount) {
    console.log(`cleanupOldSupportEmails: удалено ${result.rowCount} старых писем (старше ${RETENTION_MONTHS} мес.)`);
  }
}

module.exports = { cleanupOldSupportEmails };
