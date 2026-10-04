

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    display_name    TEXT NOT NULL DEFAULT 'Пользователь',
    photo_url       TEXT,
    role            TEXT NOT NULL DEFAULT 'user',
    onboarding_done BOOLEAN NOT NULL DEFAULT FALSE,
    telegram_id     BIGINT UNIQUE,
    telegram_username TEXT,
    telegram_linked_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_telegram_id ON users(telegram_id);

CREATE TABLE bot_tokens (
    token       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_bot_tokens_expires ON bot_tokens(expires_at);

CREATE TABLE kv_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    purpose     TEXT NOT NULL DEFAULT 'login',
    attempts    SMALLINT NOT NULL DEFAULT 0,
    max_attempts SMALLINT NOT NULL DEFAULT 5,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    ip_address  INET,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_codes_email ON auth_codes(email, purpose);

CREATE INDEX idx_auth_codes_created ON auth_codes(email, created_at);
CREATE INDEX idx_auth_codes_ip_created ON auth_codes(ip_address, created_at);

CREATE TABLE sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    device_name     TEXT,
    user_agent      TEXT,
    ip_address      INET,
    last_active_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_token ON sessions(token_hash);

CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    order_type           TEXT NOT NULL DEFAULT 'site',

    admin_notes           TEXT,

    client_name         TEXT NOT NULL,
    client_email        TEXT NOT NULL,

    package             TEXT NOT NULL,
    site_type           TEXT,
    site_format         TEXT NOT NULL,
    pages               INTEGER,
    total_price         NUMERIC(10,2) NOT NULL,
    extras              JSONB,
    domain_option       TEXT,
    domain_name         TEXT,

    promo_code          TEXT,
    discount_applied    NUMERIC(10,2) DEFAULT 0,

    description         TEXT,
    goals                JSONB,
    content_readiness   TEXT,
    references_text      TEXT,
    launch_date          DATE,

    shop_details         JSONB,
    attachments           JSONB,
    favicon_data           TEXT,

    payment_type          TEXT,
    paid_amount            NUMERIC(10,2) NOT NULL DEFAULT 0,
    remaining_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
    status                 SMALLINT NOT NULL DEFAULT -1,
    revision_requested      BOOLEAN NOT NULL DEFAULT FALSE,
    reviewed                BOOLEAN NOT NULL DEFAULT FALSE,

    site_url                TEXT,
    site_domain              TEXT,
    tariff                   TEXT,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_order_type ON orders(order_type);

CREATE TABLE order_status_history (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status      SMALLINT NOT NULL,
    changed_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_status_history_order ON order_status_history(order_id, created_at);

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
    status       TEXT NOT NULL DEFAULT 'open',
    is_read      BOOLEAN NOT NULL DEFAULT TRUE,
    admin_read   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tickets_user ON tickets(user_id);
CREATE INDEX idx_tickets_status ON tickets(status);

CREATE TABLE ticket_messages (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ticket_id   UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    sender      TEXT NOT NULL,
    text        TEXT,
    image_url   TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_messages_ticket ON ticket_messages(ticket_id, created_at);

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
    billing         TEXT,
    subscription_id UUID,
    admin_reply     TEXT,
    status          TEXT NOT NULL DEFAULT 'open',
    rating          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_service_tickets_order ON service_tickets(order_id);
CREATE INDEX idx_service_tickets_user ON service_tickets(user_id);

CREATE TABLE service_subscriptions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tariff              TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'active',
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    tickets_used        INT NOT NULL DEFAULT 0,
    auto_renew          BOOLEAN NOT NULL DEFAULT FALSE,
    expiry_notified_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_service_subscriptions_order ON service_subscriptions(order_id);
CREATE INDEX idx_service_subscriptions_user ON service_subscriptions(user_id);

CREATE TABLE subscription_renewals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    subscription_id UUID NOT NULL REFERENCES service_subscriptions(id) ON DELETE CASCADE,
    tariff          TEXT NOT NULL,
    amount          NUMERIC(10,2) NOT NULL,
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    paid_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscription_renewals_sub ON subscription_renewals(subscription_id);

ALTER TABLE service_tickets
  ADD CONSTRAINT fk_service_tickets_subscription
  FOREIGN KEY (subscription_id) REFERENCES service_subscriptions(id) ON DELETE SET NULL;
CREATE INDEX idx_service_tickets_subscription ON service_tickets(subscription_id);

CREATE TABLE notifications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    text        TEXT,
    is_read     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);

CREATE TABLE bans (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT,
    until       TIMESTAMPTZ,
    show_button BOOLEAN NOT NULL DEFAULT FALSE,
    btn_label   TEXT,
    btn_url     TEXT,
    banned_by   TEXT NOT NULL,
    banned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE promo_codes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            TEXT UNIQUE NOT NULL,
    discount_type   TEXT NOT NULL,
    discount_value  NUMERIC(10,2) NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    used_count      INTEGER NOT NULL DEFAULT 0,
    usage_limit     INTEGER,
    expires_at      TIMESTAMPTZ,
    for_user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_promo_codes_code ON promo_codes(code);

CREATE TABLE reviews (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
    text        TEXT,
    client_name TEXT,
    client_email TEXT,
    hidden      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_reviews_order_unique ON reviews(order_id);

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
CREATE TRIGGER trg_service_subscriptions_updated BEFORE UPDATE ON service_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS email_templates (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title       TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_emails (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
    thread_key      TEXT NOT NULL,
    message_id      TEXT,
    in_reply_to     TEXT,
    from_email      TEXT NOT NULL,
    from_name       TEXT,
    to_email        TEXT NOT NULL,
    subject         TEXT NOT NULL DEFAULT '(без темы)',
    body_html       TEXT,
    body_text       TEXT,
    attachments     JSONB,
    admin_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    template_id     UUID REFERENCES email_templates(id) ON DELETE SET NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_emails_thread ON support_emails(thread_key);
CREATE INDEX IF NOT EXISTS idx_support_emails_created ON support_emails(created_at DESC);

CREATE TABLE IF NOT EXISTS consent_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    doc_version TEXT NOT NULL,
    source      TEXT NOT NULL,
    ip_address  TEXT,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_log_user ON consent_log(user_id, created_at DESC);
