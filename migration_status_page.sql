-- =====================================================
-- STATUS PAGE (antviz-status): сервисы, self-check история,
-- инциденты с таймлайном, email-подписчики.
-- Накатывать поверх schema.sql + прошлых migration_*.sql
-- =====================================================

-- ── Отслеживаемые сервисы (то, что показываем на /status) ──
CREATE TABLE IF NOT EXISTS status_services (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL,                 -- "Основной сайт (antviz.ru)"
    slug        TEXT UNIQUE NOT NULL,           -- "site", "cabinet", "bot", "api", "payments", "push"
    check_url   TEXT,                           -- URL для автопроверки (GET, ожидаем 2xx). NULL = проверяется только вручную
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    -- Текущий статус. 'ok' | 'degraded' | 'partial' | 'major' | 'maint'.
    -- Обновляется автопроверкой (см. lib/statusMonitor.js), либо вручную из админки
    -- (manual_override = TRUE — тогда монитор не трогает статус, пока override не снят).
    status          TEXT NOT NULL DEFAULT 'ok',
    manual_override BOOLEAN NOT NULL DEFAULT FALSE,
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
    created_by  TEXT,                    -- email админа, создавшего инцидент
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
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

-- ── Стартовый набор сервисов (правится позже из админки) ──
INSERT INTO status_services (name, slug, check_url, sort_order) VALUES
    ('Основной сайт (antviz.ru)', 'site',     'https://antviz.ru/',              0),
    ('Личный кабинет',            'cabinet',  'https://antviz.ru/profile',       1),
    ('API и вебхуки',             'api',      'https://api.antviz.ru/api/health',2),
    ('Платежи (ЮKassa)',        'payments', NULL,                              3),
    ('Telegram-бот',              'bot',      NULL,                              4),
    ('Push-уведомления',          'push',     NULL,                              5)
ON CONFLICT (slug) DO NOTHING;

-- =====================================================
-- Аддендум: тип проверки + доп.заголовки (нужно для Vercel Deployment
-- Protection на платежах — см. check_headers) + токен Telegram-бота
-- =====================================================
ALTER TABLE status_services ADD COLUMN IF NOT EXISTS check_type TEXT NOT NULL DEFAULT 'http';
-- 'http'             — обычный GET по check_url, ожидаем 2xx/3xx
-- 'telegram_webhook' — спец-проверка через Telegram Bot API (getWebhookInfo),
--                      check_url в этом случае не используется вообще
ALTER TABLE status_services ADD COLUMN IF NOT EXISTS check_headers JSONB;
-- доп. заголовки для 'http'-проверки, например Vercel Protection Bypass:
-- {"x-vercel-protection-bypass": "секрет_из_настроек_vercel"}

UPDATE status_services SET check_url = 'https://api-lac-six-78.vercel.app/api/createPayment' WHERE slug = 'payments';
UPDATE status_services SET check_type = 'telegram_webhook', check_url = NULL WHERE slug = 'bot';

-- =====================================================
-- Аддендум: запланированные работы (scheduled_at) — инцидент можно завести
-- заранее, он не сразу считается "активным", появляется в отдельном блоке
-- "Запланировано" на публичной странице.
-- =====================================================
ALTER TABLE status_incidents ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
