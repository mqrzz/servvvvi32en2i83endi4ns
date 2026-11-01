const crypto = require('crypto');
const pool = require('../db/pool');

let geoip = null;
try { geoip = require('geoip-lite'); } catch { /* без геоданных остаётся только IP */ }

const SECRET = process.env.ANALYTICS_SALT || process.env.JWT_SECRET || 'antviz-analytics';

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS analytics_events (
    id      BIGSERIAL PRIMARY KEY,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind    TEXT NOT NULL,
    path    TEXT NOT NULL,
    ref     TEXT,
    device  TEXT,
    visitor TEXT,
    extra   TEXT
);
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS city TEXT;
CREATE INDEX IF NOT EXISTS idx_analytics_ip_ts ON analytics_events(ip, ts DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_ts ON analytics_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_kind_ts ON analytics_events(kind, ts DESC);

`;

async function ensureAnalyticsTables() {
  try {
    await pool.query(CREATE_SQL);
  } catch (err) {
    console.error('analytics: не удалось создать таблицы:', err.message);
  }
}

// Идентификатор посетителя меняется каждый день и не хранит ни IP, ни User-Agent.
function visitorHash(req) {
  const day = new Date().toISOString().slice(0, 10);
  const ua = String(req.headers['user-agent'] || '');
  return crypto.createHmac('sha256', SECRET + day).update(`${req.ip}|${ua}`).digest('hex').slice(0, 16);
}

function cleanIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '').slice(0, 64);
}

function geoLookup(ip) {
  try {
    const g = geoip && geoip.lookup(ip);
    return { country: g && g.country ? g.country : null, city: g && g.city ? g.city : null };
  } catch {
    return { country: null, city: null };
  }
}

const IGNORE = new Set(String(process.env.ANALYTICS_IGNORE_IPS || '').split(',').map((s) => s.trim()).filter(Boolean));
function isIgnoredIp(ip) {
  return IGNORE.has(ip);
}

function deviceClass(ua) {
  ua = String(ua || '');
  if (!ua || /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|telegrambot|whatsapp|curl|wget|python-requests|monitor|uptime/i.test(ua)) return 'bot';
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobi|android|iphone|ipod/i.test(ua)) return 'mobile';
  return 'desktop';
}

async function cleanupOldEvents() {
  try {
    await pool.query(`DELETE FROM analytics_events WHERE ts < now() - interval '400 days'`);
    // IP-адрес хранится 90 дней, потом стирается (страна и город остаются)
    await pool.query(`UPDATE analytics_events SET ip = NULL WHERE ip IS NOT NULL AND ts < now() - interval '90 days'`);
  } catch (err) {
    console.error('analytics: очистка не удалась:', err.message);
  }
}

module.exports = { ensureAnalyticsTables, visitorHash, deviceClass, cleanupOldEvents, cleanIp, geoLookup, isIgnoredIp };
