-- =====================================================
-- МИГРАЦИЯ: кабинет (ПК-версия) — оценка ответа поддержки, файлы в тикетах,
-- тип/ссылка у уведомлений, настройки каналов уведомлений
-- Применить один раз вручную: psql "$DATABASE_URL" -f migration-cabinet-pc.sql
-- Скрипт идемпотентный — повторный запуск ничего не ломает.
-- =====================================================

-- 1. Оценка работы поддержки по закрытому тикету (1..5 звёзд + необязательный комментарий)
ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS rating          SMALLINT CHECK (rating BETWEEN 1 AND 5),
    ADD COLUMN IF NOT EXISTS rating_comment  TEXT,
    ADD COLUMN IF NOT EXISTS rated_at        TIMESTAMPTZ;

-- 2. Файловые вложения в сообщениях тикета (pdf/zip/doc/xls/txt и т.д.).
--    Картинки по-прежнему идут через image_url (как раньше), эти поля — для остальных файлов.
--    file_data — base64 data URL, отдаётся отдельным эндпоинтом, а не в списке сообщений.
ALTER TABLE ticket_messages
    ADD COLUMN IF NOT EXISTS file_name  TEXT,
    ADD COLUMN IF NOT EXISTS file_mime  TEXT,
    ADD COLUMN IF NOT EXISTS file_size  INTEGER,
    ADD COLUMN IF NOT EXISTS file_data  TEXT;

-- 3. Уведомления: тип (order | support | service | system) и ссылка, куда ведёт клик.
--    Раньше их не было вообще — фильтры на странице «Уведомления» работали вхолостую.
ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS type  TEXT NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS link  TEXT;

-- 4. Настройки каналов уведомлений: по каждому типу — включён ли Telegram и e-mail.
--    В кабинете (колокольчик) уведомления приходят всегда, отключить их нельзя.
CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Если бэкенд ходит в базу не от владельца таблиц — выдайте права (подставьте своего пользователя):
--   GRANT SELECT, INSERT, UPDATE, DELETE ON notification_prefs TO <db_user>;
