const express = require('express');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pool');
const { visitorHash, deviceClass, cleanIp, geoLookup, isIgnoredIp } = require('../utils/analytics');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: false,
  legacyHeaders: false,
  handler: (req, res) => res.status(204).end(),
});

const KINDS = new Set(['pv', 'tg', 'read']);
const OWN_HOSTS = /(^|\.)antviz\.ru$/i;

function refHost(ref) {
  try {
    if (!ref) return null;
    const h = new URL(String(ref)).hostname.replace(/^www\./, '').toLowerCase();
    if (!h || OWN_HOSTS.test(h)) return null;
    return h.slice(0, 80);
  } catch {
    return null;
  }
}

// Публично, без cookie. IP хранится 90 дней. Всегда отвечает 204, чтобы не мешать сайту.
router.post('/', limiter, async (req, res) => {
  res.status(204).end();
  try {
    const b = req.body || {};
    const kind = String(b.k || '');
    if (!KINDS.has(kind)) return;
    let path = String(b.p || '').split('?')[0].split('#')[0];
    if (!path.startsWith('/') || path.length > 200) return;
    if (path.startsWith('/admin') || path.startsWith('/api')) return;
    const device = deviceClass(req.headers['user-agent']);
    if (device === 'bot') return;
    const extra = String(b.x || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
    const ip = cleanIp(req.ip);
    if (isIgnoredIp(ip)) return;
    const geo = geoLookup(ip);
    await pool.query(
      `INSERT INTO analytics_events (kind, path, ref, device, visitor, extra, ip, country, city) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [kind, path, kind === 'pv' ? refHost(b.r) : null, device, visitorHash(req), extra, ip || null, geo.country, geo.city]
    );
  } catch (err) {
    console.error('track:', err.message);
  }
});

module.exports = router;
