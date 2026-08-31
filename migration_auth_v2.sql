-- =====================================================
-- MIGRATION: беспарольная авторизация
-- email+код остаётся основным способом, добавляются:
--   - Яндекс OAuth (привязка по yandex_id, слияние по email)
--   - Passkey (WebAuthn)
--   - Authenticator (TOTP) — как 2FA И как альтернативный способ входа,
--     если человек потерял доступ к почте
--   - Один (не пачка) резервный код на случай потери и почты, и телефона
-- Применять: psql -U <user> -d <db> -f migration_auth_v2.sql
-- =====================================================

-- Пароль больше не обязателен при регистрации — колонку не удаляем
-- (у существующих пользователей там уже есть bcrypt-хэш, пусть висит,
-- просто перестаём его требовать и писать новые значения).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN yandex_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN totp_secret TEXT;                    -- base32-секрет, есть только пока не подтверждён/включён
ALTER TABLE users ADD COLUMN totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN recovery_code_hash TEXT;              -- ОДИН резервный код (не набор), хэш как у auth-кодов
ALTER TABLE users ADD COLUMN recovery_code_created_at TIMESTAMPTZ;

CREATE INDEX idx_users_yandex_id ON users(yandex_id);

-- =====================================================
-- PASSKEY (WebAuthn) — у юзера может быть несколько (телефон, ноут и т.д.)
-- =====================================================
CREATE TABLE passkeys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_id   TEXT UNIQUE NOT NULL,   -- base64url id от браузера
    public_key      TEXT NOT NULL,          -- base64url публичный ключ
    counter         BIGINT NOT NULL DEFAULT 0,
    device_name     TEXT,                   -- "Chrome на Windows" — из UA в момент регистрации ключа
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at    TIMESTAMPTZ
);
CREATE INDEX idx_passkeys_user ON passkeys(user_id);

-- Временные challenge'ы WebAuthn на время рукопожатия браузер↔сервер
-- (обычно живут ~2 минуты). user_id NULL для дискаверабл-входа по Passkey
-- без email — на этом шаге сервер ещё не знает, кто это.
CREATE TABLE webauthn_challenges (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    challenge   TEXT NOT NULL,
    purpose     TEXT NOT NULL,   -- 'register' | 'login'
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);
