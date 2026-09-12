-- У тебя enterprise_applications уже создана прошлой миграцией — этот файл
-- только добавляет привязку заявки к аккаунту, если заявку подали уже
-- войдя в личный кабинет (нужно для статуса заявки в кабинете, п.7).
-- Применять: psql "$DATABASE_URL" -f migration_enterprise_user_id.sql

ALTER TABLE enterprise_applications ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_enterprise_applications_user ON enterprise_applications(user_id);
