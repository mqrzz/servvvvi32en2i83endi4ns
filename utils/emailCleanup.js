// Автоочистка почты поддержки — письма (вместе с вложениями, они лежат
// в той же строке в JSONB) старше RETENTION_MONTHS удаляются целиком.
// Вложения хранятся как base64 прямо в support_emails.attachments, поэтому
// без такой чистки база будет только расти. Проверяем раз в сутки — этого
// достаточно с запасом для окна в пару месяцев, отдельный cron не нужен.
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
