-- =====================================================
-- МИГРАЦИЯ: почта поддержки (support@antviz.ru в админке)
-- Применить один раз вручную: psql "$DATABASE_URL" -f migration-support-email.sql
-- =====================================================

-- Шаблоны писем (используются и при ответе, и при написании нового письма)
CREATE TABLE IF NOT EXISTS email_templates (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title       TEXT NOT NULL,
    subject     TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '', -- поддерживает {{name}} и {{email}} — подставляются на фронте перед отправкой
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сама переписка: входящие (с воркера Cloudflare) и исходящие (ответы/новые письма из админки)
-- thread_key = lower(email контрагента) — вся переписка с одним адресом собирается в один тред,
-- независимо от темы письма (так проще для саппорта, чем группировка по Subject/References).
CREATE TABLE IF NOT EXISTS support_emails (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    direction       TEXT NOT NULL CHECK (direction IN ('in','out')),
    thread_key      TEXT NOT NULL,
    message_id      TEXT,           -- Message-ID письма (входящего — из заголовка, исходящего — что вернул nodemailer)
    in_reply_to     TEXT,           -- Message-ID письма, на которое отвечаем (для склейки в тред у получателя)
    from_email      TEXT NOT NULL,
    from_name       TEXT,
    to_email        TEXT NOT NULL,
    subject         TEXT NOT NULL DEFAULT '(без темы)',
    body_html       TEXT,
    body_text       TEXT,
    attachments     JSONB,          -- [{name, type, size, data}] — data это base64 data URL
    admin_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    template_id     UUID REFERENCES email_templates(id) ON DELETE SET NULL,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_emails_thread ON support_emails(thread_key);
CREATE INDEX IF NOT EXISTS idx_support_emails_created ON support_emails(created_at DESC);
