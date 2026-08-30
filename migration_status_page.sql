-- =====================================================
-- STATUS PAGE (antviz-status): сервисы, self-check история,
-- инциденты с таймлайном, email-подписчики.
-- Накатывать поверх schema.sql + прошлых migration_*.sql
--
-- ВАЖНО: этот файл безопасно катить повторно (все CREATE/ALTER — IF NOT
-- EXISTS, INSERT — ON CONFLICT DO NOTHING). Тут больше НЕТ одноразовых
-- UPDATE, которые правили бы уже существующие строки — раньше именно
-- из-за них повторный прогон миграции откатывал ручные правки в админке
-- (сервис "push" пересоздавался заново, у бота слетал способ проверки).
-- Если нужно поменять check_url/check_type/check_headers для существующего
-- сервиса — делай это через вкладку "Сервисы" в админке на /status.html,
-- не через миграцию.
-- =====================================================

-- ── Отслеживаемые сервисы (то, что показываем на /status) ──
CREATE TABLE IF NOT EXISTS status_services (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,                 -- "Основной сайт (antviz.ru)"
    slug        TEXT UNIQUE NOT NULL,           -- "site", "cabinet", "bot", "api", "payments", "github"
    check_url   TEXT,                           -- URL для автопроверки (GET, ожидаем 2xx). NULL = проверяется только вручную
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    -- Текущий статус. 'ok' | 'degraded' | 'partial' | 'major' | 'maint'.
    -- Обновляется автопроверкой (см. lib/statusMonitor.js), либо вручную из админки
    -- (manual_override = TRUE — тогда монитор не трогает статус, пока override не снят).
    status          TEXT NOT NULL DEFAULT 'ok',
    manual_override BOOLEAN NOT NULL DEFAULT FALSE,
    -- 'http' (обычный GET) | 'telegram_webhook' (спец-проверка бота через Telegram —
    -- НЕ используй, если сервер не может достучаться до api.telegram.org напрямую,
    -- см. lib/statusMonitor.js) | 'github_status' (читает githubstatus.com)
    check_type      TEXT NOT NULL DEFAULT 'http',
    check_headers   JSONB,                      -- доп. заголовки для 'http', например Vercel Protection Bypass
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Лог автопроверок (используется для расчёта % аптайма и дневных полосок) ──
CREATE TABLE IF NOT EXISTS status_checks (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_id  UUID NOT NULL REFERENCES status_services(id) ON DELETE CASCADE,
    ok          BOOLEAN NOT NULL,
    status_code SMALLINT,
    latency_ms  INT,
    error       TEXT,
    checked_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_checks_service_time ON status_checks(service_id, checked_at DESC);

-- ── Инциденты ──
CREATE TABLE IF NOT EXISTS status_incidents (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    service_id  UUID REFERENCES status_services(id) ON DELETE SET NULL,
    title       TEXT NOT NULL,
    -- 'degraded' | 'partial' | 'major' | 'maint' — влияет на цвет бейджа и на статус сервиса, пока инцидент открыт
    severity    TEXT NOT NULL DEFAULT 'partial',
    -- 'investigating' | 'identified' | 'monitoring' | 'resolved'
    status      TEXT NOT NULL DEFAULT 'investigating',
    created_by  TEXT,                    -- email админа, создавшего инцидент, либо 'auto'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ,
    -- Запланированные работы на будущее — см. POST /api/status/incidents.
    -- NULL или прошедшая дата = "происходит прямо сейчас".
    scheduled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_status_incidents_created ON status_incidents(created_at DESC);

-- ── Таймлайн обновлений внутри инцидента ──
CREATE TABLE IF NOT EXISTS status_incident_updates (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    incident_id UUID NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,   -- 'investigating' | 'identified' | 'monitoring' | 'resolved'
    message     TEXT NOT NULL,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_updates_incident ON status_incident_updates(incident_id, created_at ASC);

-- ── Подписчики на уведомления об инцидентах ──
CREATE TABLE IF NOT EXISTS status_subscribers (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email             TEXT UNIQUE NOT NULL,
    unsubscribe_token TEXT UNIQUE NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Стартовый набор сервисов (правится позже из админки, а не здесь) ──
-- check_headers (секреты для Vercel Protection Bypass у payments/bot) сюда
-- намеренно НЕ зашиты — впиши их один раз через вкладку "Сервисы" в админке
-- после установки, там же где check_url/check_type.
INSERT INTO status_services (name, slug, check_url, check_type, sort_order) VALUES
    ('Основной сайт (antviz.ru)', 'site',     'https://antviz.ru/',                              'http',           0),
    ('Личный кабинет',            'cabinet',  'https://antviz.ru/profile',                       'http',           1),
    ('API и вебхуки',             'api',      'http://localhost:3000/api/status',                'http',           2),
    ('Платежи (ЮKassa)',          'payments', 'https://api-lac-six-78.vercel.app/api/health',    'http',           3),
    ('Telegram-бот',              'bot',      'https://3ssqztgbot22wsq.vercel.app/api/health',   'http',           4),
    ('GitHub',                    'github',   'https://www.githubstatus.com/api/v2/status.json', 'github_status',  5)
ON CONFLICT (slug) DO NOTHING;
