const pool = require('../db/pool');

const SQL = `
CREATE TABLE IF NOT EXISTS site_requests (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  contact     TEXT NOT NULL,
  message     TEXT NOT NULL,
  services    TEXT[] NOT NULL DEFAULT '{}',
  page        TEXT,
  status      TEXT NOT NULL DEFAULT 'new',
  note        TEXT,
  ip_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_requests_created ON site_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_requests_status ON site_requests(status, created_at DESC);

CREATE TABLE IF NOT EXISTS blog_subscribers (
  id                BIGSERIAL PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  confirm_token     TEXT,
  unsubscribe_token TEXT NOT NULL,
  source            TEXT,
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function ensureSiteTables() {
  try {
    await pool.query(SQL);
  } catch (err) {
    console.error('site tables: не удалось создать таблицы:', err.message);
  }
}
module.exports = { ensureSiteTables };
