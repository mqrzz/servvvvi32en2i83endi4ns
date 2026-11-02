const crypto = require('crypto');
const pool = require('../db/pool');
const icons = require('./uzel-icons');

const THEMES = ['light', 'dark', 'blue', 'warm', 'mint', 'sunset', 'graphite', 'lilac'];
const SHAPES = ['soft', 'round', 'square'];
const RESERVED = new Set(['app', 'api', 'admin', 'assets', 'go', 'media', 'report', 'rules', 'privacy', 'login', 'logout', 'static', 'www', 'mail', 'help', 'support', 'antviz', 'uzel', 'about', 'terms', 'status', 'blog', 'robots', 'sitemap', 'favicon', 'index', 'dashboard', 'settings', 'me', 'null', 'undefined', 'test', 'root', 'system', 'security', 'billing', 'pay', 'official']);

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS uzel_users (
    id            BIGSERIAL PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT,
    banned        BOOLEAN NOT NULL DEFAULT false,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS uzel_codes (
    id         BIGSERIAL PRIMARY KEY,
    email      TEXT NOT NULL,
    code_hash  TEXT NOT NULL,
    attempts   INT NOT NULL DEFAULT 0,
    used       BOOLEAN NOT NULL DEFAULT false,
    ip         TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uzel_codes_email ON uzel_codes(email, created_at DESC);
CREATE TABLE IF NOT EXISTS uzel_sessions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES uzel_users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    ua           TEXT,
    ip           TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS uzel_pages (
    id         BIGSERIAL PRIMARY KEY,
    user_id    BIGINT NOT NULL UNIQUE REFERENCES uzel_users(id) ON DELETE CASCADE,
    slug       TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    subtitle   TEXT NOT NULL DEFAULT '',
    bio        TEXT NOT NULL DEFAULT '',
    avatar     TEXT,
    theme      TEXT NOT NULL DEFAULT 'light',
    socials    JSONB NOT NULL DEFAULT '[]',
    links      JSONB NOT NULL DEFAULT '[]',
    music      JSONB,
    published  BOOLEAN NOT NULL DEFAULT true,
    hidden     BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE uzel_pages ADD COLUMN IF NOT EXISTS ext JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS uzel_events (
    id      BIGSERIAL PRIMARY KEY,
    page_id BIGINT NOT NULL REFERENCES uzel_pages(id) ON DELETE CASCADE,
    kind    TEXT NOT NULL,
    link_id TEXT,
    ref     TEXT,
    device  TEXT,
    ts      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uzel_events_page ON uzel_events(page_id, ts DESC);
CREATE TABLE IF NOT EXISTS uzel_reports (
    id         BIGSERIAL PRIMARY KEY,
    page_id    BIGINT NOT NULL REFERENCES uzel_pages(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    details    TEXT,
    handled    BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

async function ensureUzelTables() {
  try {
    await pool.query(CREATE_SQL);
  } catch (err) {
    console.error('uzel: не удалось создать таблицы:', err.message);
  }
}

async function cleanupUzel() {
  try {
    await pool.query(`DELETE FROM uzel_codes WHERE expires_at < now() - interval '1 day'`);
    await pool.query(`DELETE FROM uzel_sessions WHERE expires_at < now()`);
    await pool.query(`DELETE FROM uzel_events WHERE ts < now() - interval '400 days'`);
  } catch (err) {
    console.error('uzel: очистка не удалась:', err.message);
  }
}

/* ---------- валидация ---------- */
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function validateSlug(slug) {
  slug = String(slug || '').toLowerCase().trim();
  if (slug.length < 3 || slug.length > 30) return { ok: false, reason: 'От 3 до 30 символов' };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug) || slug.includes('--')) return { ok: false, reason: 'Только латиница, цифры и дефис, без двойного дефиса' };
  if (RESERVED.has(slug)) return { ok: false, reason: 'Этот адрес зарезервирован' };
  return { ok: true, slug };
}

function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u || u.length > 500) return null;
  if (/^mailto:/i.test(u)) return /^mailto:[^\s<>"']{3,200}$/i.test(u) && /@/.test(u) ? u : null;
  if (/^tel:/i.test(u)) return /^tel:\+?[0-9\-\s()]{5,20}$/i.test(u) ? u.replace(/\s/g, '') : null;
  if (!/^https?:\/\//i.test(u)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$|\?|#)/i.test(u)) u = 'https://' + u;
    else return null;
  }
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    if (x.username || x.password) return null;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || /^[0-9.]+$/.test(h) || h.includes(':') || h.endsWith('.local') || h.endsWith('.internal')) return null;
    return x.toString();
  } catch {
    return null;
  }
}

const SOCIALS = {
  telegram: { hosts: ['t.me', 'telegram.me'], build: (v) => `https://t.me/${v}`, label: 'Telegram' },
  instagram: { hosts: ['instagram.com', 'www.instagram.com'], build: (v) => `https://instagram.com/${v}`, label: 'Instagram' },
  tiktok: { hosts: ['tiktok.com', 'www.tiktok.com'], build: (v) => `https://tiktok.com/@${v}`, label: 'TikTok' },
  youtube: { hosts: ['youtube.com', 'www.youtube.com', 'youtu.be'], build: (v) => `https://youtube.com/@${v}`, label: 'YouTube' },
  vk: { hosts: ['vk.com', 'vk.ru'], build: (v) => `https://vk.com/${v}`, label: 'VK' },
  github: { hosts: ['github.com'], build: (v) => `https://github.com/${v}`, label: 'GitHub' },
  x: { hosts: ['x.com', 'twitter.com'], build: (v) => `https://x.com/${v}`, label: 'X' },
  whatsapp: { hosts: ['wa.me'], build: (v) => `https://wa.me/${v}`, label: 'WhatsApp' },
};

function normalizeSocial(type, value) {
  const def = SOCIALS[type];
  if (!def) return null;
  let v = String(value || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    const u = normalizeUrl(v);
    if (!u) return null;
    return def.hosts.includes(new URL(u).hostname.toLowerCase()) ? u : null;
  }
  v = v.replace(/^@/, '');
  if (type === 'whatsapp') {
    v = v.replace(/[\s+()-]/g, '');
    return /^[0-9]{7,15}$/.test(v) ? def.build(v) : null;
  }
  return /^[A-Za-z0-9._-]{1,60}$/.test(v) ? def.build(v) : null;
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function validatePage(input, existing) {
  const errors = [];
  const out = {};
  const name = cleanText(input.name, 60);
  if (!name) errors.push('Укажите имя');
  out.name = name;
  out.subtitle = cleanText(input.subtitle, 80);
  out.bio = cleanText(input.bio, 300);
  out.theme = THEMES.includes(input.theme) ? input.theme : (existing ? existing.theme : 'light');
  out.published = input.published === false ? false : true;
  const oldExt = (existing && existing.ext) || {};
  const shape = SHAPES.includes(input.shape) ? input.shape : (oldExt.shape || 'soft');
  const info = {};
  const ii = input.info && typeof input.info === 'object' ? input.info : {};
  const ph = String(ii.phone || '').replace(/[\s()-]/g, '');
  if (ph) { if (/^\+?[0-9]{7,15}$/.test(ph)) info.phone = ph; else errors.push('Телефон: только цифры и +, от 7 до 15 цифр'); }
  const em = String(ii.email || '').trim();
  if (em) { if (/^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[A-Za-z]{2,}$/.test(em) && em.length <= 254) info.email = em; else errors.push('Проверьте почту в контактах'); }
  const ad = cleanText(ii.address, 120);
  if (ad) info.address = ad;
  out.ext = { shape, info };

  const socials = [];
  const seen = new Set();
  for (const s of Array.isArray(input.socials) ? input.socials.slice(0, 12) : []) {
    if (!s || !s.type || seen.has(s.type)) continue;
    const url = normalizeSocial(String(s.type), s.value);
    if (!url) { if (String(s.value || '').trim()) errors.push(`Не удалось распознать ссылку ${SOCIALS[s.type] ? SOCIALS[s.type].label : s.type}`); continue; }
    seen.add(s.type);
    socials.push({ type: s.type, url });
  }
  out.socials = socials;

  const links = [];
  const ids = new Set();
  for (const l of Array.isArray(input.links) ? input.links.slice(0, 20) : []) {
    if (!l) continue;
    const title = cleanText(l.title, 60);
    const raw = String(l.url || '').trim();
    if (!title && !raw) continue;
    if (l.kind === 'header') {
      if (!title) continue;
      let hid = /^[a-f0-9]{8}$/.test(String(l.id || '')) && !ids.has(l.id) ? l.id : newId();
      ids.add(hid);
      links.push({ id: hid, kind: 'header', title, enabled: l.enabled !== false });
      continue;
    }
    const url = normalizeUrl(raw);
    if (!title || !url) { errors.push(`Проверьте ссылку «${title || raw.slice(0, 30)}»`); continue; }
    let id = /^[a-f0-9]{8}$/.test(String(l.id || '')) && !ids.has(l.id) ? l.id : newId();
    ids.add(id);
    const desc = cleanText(l.desc, 80);
    links.push(Object.assign({ id, title, url, enabled: l.enabled !== false }, desc ? { desc } : {}));
  }
  out.links = links;

  if (input.music && (input.music.url || input.music.title)) {
    const url = normalizeUrl(input.music.url);
    const title = cleanText(input.music.title, 60);
    if (!url || !title) errors.push('Для музыки нужны название и ссылка');
    else out.music = { title, url };
  } else out.music = null;

  return errors.length ? { ok: false, errors } : { ok: true, data: out };
}

/* ---------- публичная страница ---------- */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function initials(name) {
  const p = String(name).trim().split(/\s+/).filter(Boolean);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
function gradient(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg,hsl(${h},85%,62%),hsl(${(h + 40) % 360},85%,58%))`;
}
const brandSvg = (t) => (icons.brands[t] ? `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${icons.brands[t]}"/></svg>` : '');
const lucideSvg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.lucide[n]}</svg>`;

// Путь, под которым лежит сайт «Узла». Пока Узел живёт на antviz.ru/uzel/, потом на своём домене: UZEL_BASE=
const BASE = process.env.UZEL_BASE === undefined ? '/uzel' : process.env.UZEL_BASE.replace(/\/+$/, '');
const PAGE_CSS = `
@font-face{font-family:Unbounded;font-weight:800;src:url(${BASE}/assets/fonts/unbounded-cyrillic-800-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:Unbounded;font-weight:800;src:url(${BASE}/assets/fonts/unbounded-latin-800-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
@font-face{font-family:"Golos Text";font-weight:400 700;src:url(${BASE}/assets/fonts/golos-text-cyrillic-600-normal.woff2) format("woff2");unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116}
@font-face{font-family:"Golos Text";font-weight:400 700;src:url(${BASE}/assets/fonts/golos-text-latin-600-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+2000-206F,U+20AC,U+2122,U+2212}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}
body{font:17px/1.45 "Golos Text",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;display:flex;justify-content:center;padding:40px 18px 28px}
.w{width:min(480px,100%);display:flex;flex-direction:column;align-items:center;text-align:center}
.av{width:112px;height:112px;border-radius:50%;display:grid;place-items:center;font:800 36px Unbounded,sans-serif;letter-spacing:-.05em;color:#fff;box-shadow:0 14px 34px #0003;overflow:hidden}
.av img{width:100%;height:100%;object-fit:cover;display:block}
h1{font:800 clamp(26px,6vw,32px)/1.1 Unbounded,"Golos Text",sans-serif;letter-spacing:-.05em;margin:18px 0 0}
.sub{margin:8px 0 0;font-weight:600;opacity:.72}.bio{margin:10px 0 0;opacity:.9;max-width:400px;white-space:pre-line}
.soc{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:18px}
.soc a{width:48px;height:48px;border-radius:50%;display:grid;place-items:center;color:inherit;text-decoration:none;transition:transform .2s}.soc a:hover{transform:translateY(-2px)}.soc svg{width:22px;height:22px}
.lk{width:100%;display:flex;flex-direction:column;gap:12px;margin-top:22px}
.lk a{min-height:60px;border-radius:20px;display:flex;align-items:center;gap:14px;padding:0 20px;font-weight:700;font-size:17px;color:inherit;text-decoration:none;text-align:left;transition:transform .2s}.lk a:hover{transform:translateY(-2px)}
.lk a span{flex:1;overflow:hidden;text-overflow:ellipsis}.lk svg{width:22px;height:22px;flex:none}.lk .ar{opacity:.5}
.ft{margin-top:34px;display:flex;gap:18px;font-size:14px;opacity:.75}.ft a{color:inherit}
.t-light{background:#f2f2f4;color:#0b0b0d}.t-light .lk a,.t-light .soc a{background:#fff;box-shadow:0 2px 0 #0b0b0d0d}
.t-dark{background:#0b0b0d;color:#fff}.t-dark .lk a,.t-dark .soc a{background:#1e1b1d}
.t-blue{background:linear-gradient(160deg,#4d94ff,#0055e0) fixed;color:#fff}.t-blue .lk a,.t-blue .soc a{background:#ffffff26}
.t-warm{background:#ffe9d6;color:#2a1608}.t-warm .lk a,.t-warm .soc a{background:#fff7ef}
.t-mint{background:#dff5e8;color:#0a2a1a}.t-mint .lk a,.t-mint .soc a,.t-mint .ct a{background:#f4fff8}
.t-sunset{background:linear-gradient(160deg,#ff8a5b,#c2255c 60%,#5b21b6) fixed;color:#fff}.t-sunset .lk a,.t-sunset .soc a,.t-sunset .ct a{background:#ffffff26}
.t-graphite{background:#26272b;color:#f2f2f4}.t-graphite .lk a,.t-graphite .soc a,.t-graphite .ct a{background:#34353a}
.t-lilac{background:#ece6ff;color:#1d1236}.t-lilac .lk a,.t-lilac .soc a,.t-lilac .ct a{background:#faf8ff}
.t-light .ct a{background:#fff;box-shadow:0 2px 0 #0b0b0d0d}.t-dark .ct a{background:#1e1b1d}.t-blue .ct a{background:#ffffff26}.t-warm .ct a{background:#fff7ef}
.ct{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:18px}.ct a{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;border-radius:999px;color:inherit;text-decoration:none;font-weight:700;font-size:15px}.ct svg{width:18px;height:18px}
.lk small{display:block;font-weight:500;font-size:13px;opacity:.7;margin-top:2px;white-space:normal}
.lk .hd{font:800 13px Unbounded,"Golos Text",sans-serif;letter-spacing:.02em;text-transform:uppercase;opacity:.6;margin:14px 0 -2px;text-align:left}
.s-round .lk a{border-radius:999px}.s-square .lk a{border-radius:6px}.s-square .soc a{border-radius:8px}
`;

function renderPublicPage(page, origin) {
  const t = THEMES.includes(page.theme) ? page.theme : 'light';
  const avatar = page.avatar
    ? `<img src="/api/uzel/media/${esc(page.avatar)}" alt="" width="112" height="112">`
    : esc(initials(page.name));
  const soc = (page.socials || []).filter((s) => icons.brands[s.type]).map((s) => `<a href="/api/uzel/go/${esc(page.slug)}/s-${esc(s.type)}" rel="nofollow noopener ugc" aria-label="${esc(SOCIALS[s.type] ? SOCIALS[s.type].label : s.type)}">${brandSvg(s.type)}</a>`).join('');
  const links = (page.links || []).filter((l) => l.enabled !== false).map((l) => l.kind === 'header' ? `<h2 class="hd">${esc(l.title)}</h2>` : `<a href="/api/uzel/go/${esc(page.slug)}/${esc(l.id)}" rel="nofollow noopener ugc">${lucideSvg('link')}<span>${esc(l.title)}${l.desc ? `<small>${esc(l.desc)}</small>` : ''}</span>${lucideSvg('arrow-up-right').replace('<svg', '<svg class="ar"')}</a>`).join('');
  const info = (page.ext && page.ext.info) || {};
  const infoBtns = [info.phone ? ['i-phone', 'phone', 'Позвонить'] : null, info.email ? ['i-email', 'mail', 'Написать'] : null, info.address ? ['i-map', 'map-pin', 'Как добраться'] : null].filter(Boolean)
    .map(([id, ic, t]) => `<a href="/api/uzel/go/${esc(page.slug)}/${id}" rel="nofollow noopener ugc">${lucideSvg(ic)}<span>${t}</span></a>`).join('');
  const shape = (page.ext && page.ext.shape) || 'soft';
  const music = page.music ? `<a href="/api/uzel/go/${esc(page.slug)}/music" rel="nofollow noopener ugc">${lucideSvg('music')}<span>${esc(page.music.title)}</span>${lucideSvg('arrow-up-right').replace('<svg', '<svg class="ar"')}</a>` : '';
  const desc = esc(page.bio || page.subtitle || `Страница ${page.name} на Узле`);
  const img = page.avatar ? `<meta property="og:image" content="${esc(origin)}/api/uzel/media/${esc(page.avatar)}">` : '';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.name)} · Узел</title><meta name="description" content="${desc}"><meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${esc(page.name)}"><meta property="og:description" content="${desc}"><meta property="og:type" content="profile">${img}
<meta name="theme-color" content="${({ dark: '#0b0b0d', blue: '#0055e0', warm: '#ffe9d6', mint: '#dff5e8', sunset: '#c2255c', graphite: '#26272b', lilac: '#ece6ff' })[t] || '#f2f2f4'}">
<link rel="icon" href="${BASE}/assets/favicon.svg" type="image/svg+xml"><style>${PAGE_CSS}</style></head>
<body class="t-${t} s-${shape}"><main class="w"><div class="av" style="background:${gradient(page.name)}">${avatar}</div><h1>${esc(page.name)}</h1>${page.subtitle ? `<p class="sub">${esc(page.subtitle)}</p>` : ''}${page.bio ? `<p class="bio">${esc(page.bio)}</p>` : ''}${soc ? `<div class="soc">${soc}</div>` : ''}${infoBtns ? `<div class="ct">${infoBtns}</div>` : ''}<div class="lk">${links}${music}</div>
<div class="ft"><a href="${esc(origin)}${BASE}/">Сделано на Узле</a><a href="/api/uzel/report/${esc(page.slug)}">Пожаловаться</a></div></main></body></html>`;
}

function simplePage(title, body, status) {
  return { status: status || 200, html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Узел</title><style>${PAGE_CSS}.card{background:#fff;border-radius:28px;padding:30px;box-shadow:0 0 0 1px #0b0b0d1a;text-align:left;width:100%}.card h1{font-size:26px;margin:0 0 12px}.card p{margin:0 0 14px;color:#4a474b}.card select,.card textarea{width:100%;border:0;background:#f2f2f4;border-radius:16px;padding:14px 16px;font:inherit;margin-bottom:12px}.card button,.card .b{display:inline-flex;align-items:center;height:52px;padding:0 24px;border-radius:16px;border:0;background:#06f;color:#fff;font:700 17px inherit;text-decoration:none;cursor:pointer}</style></head><body class="t-light"><main class="w"><div class="card">${body}</div></main></body></html>` };
}

module.exports = { SHAPES, BASE, ensureUzelTables, cleanupUzel, THEMES, RESERVED, SOCIALS, cleanText, validateSlug, normalizeUrl, normalizeSocial, validatePage, newId, renderPublicPage, simplePage, esc };
