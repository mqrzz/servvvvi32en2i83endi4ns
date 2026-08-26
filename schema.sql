-- =====================================================
-- ANTVIZ DATABASE SCHEMA (PostgreSQL)
-- Замена Firebase Auth + Firestore
-- =====================================================

-- ── РАСШИРЕНИЯ ──
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- 1. ПОЛЬЗОВАТЕЛИ (замена Firebase Auth + users collection)
-- =====================================================
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(), -- аналог uid
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,                  -- bcrypt-хэш, пароль никогда не хранится открыто
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,  -- подтверждён ли email кодом при регистрации
    display_name    TEXT NOT NULL DEFAULT 'Пользователь',
    photo_url       TEXT,
    role            TEXT NOT NULL DEFAULT 'user', -- 'user' | 'admin'
    onboarding_done BOOLEAN NOT NULL DEFAULT FALSE, -- из welcome.html
    telegram_id     BIGINT UNIQUE,                  -- привязка к боту (для tg-enter.html)
    telegram_username TEXT,
    telegram_linked_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_telegram_id ON users(telegram_id);

-- =====================================================
-- 1.1 ОДНОРАЗОВЫЕ ТОКЕНЫ БОТА (привязка аккаунта / вход из мини-аппа)
-- =====================================================
CREATE TABLE bot_tokens (
    token       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL, -- 'link' (привязка бота к аккаунту) | 'app_auth' (вход в мини-апп из бота)
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bot_tokens_expires ON bot_tokens(expires_at);

-- =====================================================
-- 1.2 ПРОСТОЕ KEY-VALUE ХРАНИЛИЩЕ ДЛЯ БОТА
-- Vercel-функции бота не имеют своего постоянного хранилища (в отличие от
-- VPS с файлом .maintenance) — техработы бота и состояние "жду текст
-- рассылки от админа" храним здесь.
-- =====================================================
CREATE TABLE kv_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- 2. КОДЫ ПОДТВЕРЖДЕНИЯ (вход по email+код)
-- =====================================================
CREATE TABLE auth_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,        -- хранить хэш кода, не сам код
    purpose     TEXT NOT NULL DEFAULT 'login', -- 'login' | 'register' | 'delete_account'
    attempts    SMALLINT NOT NULL DEFAULT 0,   -- попыток ввода
    max_attempts SMALLINT NOT NULL DEFAULT 5,
    expires_at  TIMESTAMPTZ NOT NULL, -- обычно now() + 10 минут
    used_at     TIMESTAMPTZ,          -- когда код был использован (чтобы нельзя повторно)
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_codes_email ON auth_codes(email, purpose);
-- для rate-limit: сколько кодов отправлено на email/IP за последний час
CREATE INDEX idx_auth_codes_created ON auth_codes(email, created_at);
CREATE INDEX idx_auth_codes_ip_created ON auth_codes(ip_address, created_at);

-- =====================================================
-- 3. СЕССИИ / УСТРОЙСТВА (profile/sessions.js)
-- =====================================================
CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE, -- хэш refresh/session токена, не сам токен
    device_name     TEXT,                  -- "Chrome на Windows", распознаём из User-Agent
    user_agent      TEXT,
    ip_address      INET,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ            -- NULL = активна; иначе завершена (разлогин)
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

-- =====================================================
-- 4. ЗАКАЗЫ (order.html, profile/orders.html, admin/orders.html)
-- =====================================================
CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- клиентские данные на момент заказа (снапшот, как было в Firestore)
    client_name         TEXT NOT NULL,
    client_email        TEXT NOT NULL,

    -- параметры заказа
    package             TEXT NOT NULL,        -- t.name — название тарифа
    site_type           TEXT,                 -- siteKind
    site_format         TEXT NOT NULL,        -- FORMAT_LABELS[state.format] / "Особый случай: ..."
    pages               INTEGER,
    total_price         NUMERIC(10,2) NOT NULL,
    extras              JSONB,                -- extrasArr
    domain_option       TEXT,
    domain_name         TEXT,

    promo_code          TEXT,
    discount_applied    NUMERIC(10,2) DEFAULT 0,

    description         TEXT,                 -- briefText
    goals                JSONB,
    content_readiness   TEXT,
    references_text      TEXT,
    launch_date          DATE,

    shop_details         JSONB,                -- {payment, delivery, quantity} для формата shop
    attachments           JSONB,
    favicon_data           TEXT,

    payment_type          TEXT,                -- YooKassa/Robokassa и т.д.
    paid_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
    remaining_amount        NUMERIC(10,2) NOT NULL DEFAULT 0, -- для частичной оплаты (50%)
    status                 SMALLINT NOT NULL DEFAULT -1, -- как в исходнике: -1 = ждёт оплаты и т.д.
    revision_requested      BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed                BOOLEAN NOT NULL DEFAULT FALSE,

    site_url                TEXT,             -- ссылка на готовый сайт при сдаче
    site_domain              TEXT,
    tariff                   TEXT,             -- используется в review-запросах как sel.tariff

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);

-- =====================================================
-- 5. ТИКЕТЫ ПОДДЕРЖКИ (profile/tickets.html, profile/support.html, admin/tickets.html)
-- В Firestore было ДВЕ похожих коллекции: 'tickets' (support chat) и 'service_tickets'
-- (заявки по заказам с рейтингом) — разносим в две таблицы, т.к. модель разная.
-- =====================================================

-- 5a. Обращения в поддержку (support-чат, живой диалог)
CREATE TABLE tickets (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name    TEXT NOT NULL,
    user_email   TEXT NOT NULL,
    topic        TEXT,
    priority     TEXT,
    subject      TEXT NOT NULL,
    order_id     UUID REFERENCES orders(id) ON DELETE SET NULL,
    order_label  TEXT,
    status       TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done'
    is_read      BOOLEAN NOT NULL DEFAULT TRUE, -- _read (увидел ли КЛИЕНТ)
    admin_read   BOOLEAN NOT NULL DEFAULT FALSE, -- увидел ли АДМИН последнее сообщение
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_user ON tickets(user_id);
CREATE INDEX idx_tickets_status ON tickets(status);

-- сообщения внутри тикета (tickets/{id}/messages в Firestore)
CREATE TABLE ticket_messages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sender      TEXT NOT NULL, -- 'user' | 'admin'
    text        TEXT,
    image_url   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

-- 5b. Заявки на обслуживание/доработку заказа (с рейтингом)
CREATE TABLE service_tickets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name       TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT,
    images          JSONB,
    order_site_type TEXT,
    order_tariff    TEXT,
    order_domain    TEXT,
    billing         TEXT, -- 'subscription' и т.д.
    admin_reply     TEXT,
    status          TEXT NOT NULL DEFAULT 'open', -- 'open' | 'done'
    rating          TEXT, -- 'up' | 'down', выставляется юзером после завершения
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_tickets_order ON service_tickets(order_id);
CREATE INDEX idx_service_tickets_user ON service_tickets(user_id);

-- =====================================================
-- 6. УВЕДОМЛЕНИЯ (profile/notifications.html)
-- Firestore: notifications/{uid}/items/{id} → плоская таблица с user_id
-- =====================================================
CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    text        TEXT,
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);

-- =====================================================
-- 7. БАНЫ (admin/bans.html)
-- =====================================================
CREATE TABLE bans (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT,
    until       TIMESTAMPTZ,          -- NULL = навсегда
    show_button BOOLEAN NOT NULL DEFAULT FALSE,
    btn_label   TEXT,
    btn_url     TEXT,
    banned_by   TEXT NOT NULL,        -- email админа
    banned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================
-- 8. ПРОМОКОДЫ (admin/promos.html)
-- =====================================================
CREATE TABLE promo_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            TEXT UNIQUE NOT NULL,
    discount_type   TEXT NOT NULL,     -- 'percent' | 'fixed'
    discount_value  NUMERIC(10,2) NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    used_count      INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ,
    for_user_id     UUID REFERENCES users(id) ON DELETE CASCADE, -- персональный промокод
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_promo_codes_code ON promo_codes(code);

-- =====================================================
-- 9. ОТЗЫВЫ (admin/reviews.html, profile/orders.html)
-- =====================================================
CREATE TABLE reviews (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    text        TEXT,
    client_name TEXT,
    client_email TEXT,
    hidden      BOOLEAN NOT NULL DEFAULT FALSE, -- модерация: скрыт с публичной страницы отзывов
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reviews_order ON reviews(order_id);

-- =====================================================
-- Автообновление updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_tickets_updated BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_service_tickets_updated BEFORE UPDATE ON service_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
