

ALTER TABLE tickets
    ADD COLUMN IF NOT EXISTS rating          SMALLINT CHECK (rating BETWEEN 1 AND 5),
    ADD COLUMN IF NOT EXISTS rating_comment  TEXT,
    ADD COLUMN IF NOT EXISTS rated_at        TIMESTAMPTZ;

ALTER TABLE ticket_messages
    ADD COLUMN IF NOT EXISTS file_name  TEXT,
    ADD COLUMN IF NOT EXISTS file_mime  TEXT,
    ADD COLUMN IF NOT EXISTS file_size  INTEGER,
    ADD COLUMN IF NOT EXISTS file_data  TEXT;

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS type  TEXT NOT NULL DEFAULT 'system',
    ADD COLUMN IF NOT EXISTS link  TEXT;

CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    prefs       JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

