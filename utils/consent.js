const pool = require('../db/pool');

const DOC_VERSION = '2026-10-04';

const CREATE_SQL = `
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
`;

async function ensureConsentTable() {
  try {
    await pool.query(CREATE_SQL);
  } catch (err) {
    console.error('consent_log: не удалось создать таблицу:', err.message);
  }
}

async function logConsent(userId, kinds, req, source, client) {
  try {
    const db = client || pool;
    const ip = req && req.ip ? req.ip : null;
    const ua = req && req.headers ? String(req.headers['user-agent'] || '').slice(0, 300) : null;
    for (const kind of kinds) {
      await db.query(
        `INSERT INTO consent_log (user_id, kind, doc_version, source, ip_address, user_agent) VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, kind, DOC_VERSION, source, ip, ua]
      );
    }
  } catch (err) {
    console.error('consent_log: не удалось записать согласие:', err.message);
  }
}

module.exports = { logConsent, ensureConsentTable, DOC_VERSION };
