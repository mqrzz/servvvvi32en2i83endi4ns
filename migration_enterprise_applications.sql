-- =====================================================
-- MIGRATION: заявки на крупные проекты / собственный сервер
-- Отдельная анкета (enterprise.html) для клиентов, которым нужен
-- свой выделенный сервер, настраиваемые лимиты, крупные/нагруженные
-- проекты и т.д. — НЕ через обычный order.html.
-- Применять: psql -U <user> -d <db> -f migration_enterprise_applications.sql
-- =====================================================

CREATE TABLE IF NOT EXISTS enterprise_applications (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- контакты
    name                TEXT NOT NULL,
    company             TEXT,
    telegram_username   TEXT NOT NULL,
    email               TEXT NOT NULL,
    phone               TEXT,

    -- суть проекта
    project_type        TEXT,             -- сайт / сервис / бот / что-то ещё, свободное поле
    description         TEXT NOT NULL,     -- развёрнутое описание задачи

    -- требования к инфраструктуре — то, из-за чего это не обычный заказ
    own_server          BOOLEAN NOT NULL DEFAULT FALSE, -- нужен отдельный выделенный сервер
    servers_in_rf       TEXT,              -- 'yes' | 'no' | 'no_matter'
    custom_limits       BOOLEAN NOT NULL DEFAULT FALSE, -- нужна ручная настройка лимитов (не как в тарифах)

    expected_load       TEXT,              -- ожидаемая нагрузка/аудитория, свободное поле
    budget               TEXT,             -- ориентир по бюджету, свободное поле
    timeline             TEXT,             -- желаемые сроки

    status               TEXT NOT NULL DEFAULT 'new', -- 'new' | 'in_progress' | 'done' | 'declined'
    admin_notes           TEXT,

    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_enterprise_applications_status ON enterprise_applications(status);
CREATE INDEX IF NOT EXISTS idx_enterprise_applications_created ON enterprise_applications(created_at DESC);

CREATE TRIGGER trg_enterprise_applications_updated BEFORE UPDATE ON enterprise_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
