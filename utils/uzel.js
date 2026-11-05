const crypto = require('crypto');
const pool = require('../db/pool');
const icons = require('./uzel-icons');

const THEMES = ['light', 'dark', 'blue', 'warm', 'mint', 'sunset', 'graphite', 'lilac'];
const SHAPES = ['soft', 'round', 'square'];
const FREE_THEMES = ['light', 'dark', 'blue', 'warm'];
const LANGS = ['ru', 'en'];
const LIMITS = {
  free: { links: 10, themes: FREE_THEMES, statsDays: 14 },
  pro: { links: 50, themes: THEMES, statsDays: 90 },
  business: { links: 150, themes: THEMES, statsDays: 365 },
};
const PLAN_PRICES = {
  pro_month: { tier: 'pro', amount: '199.00', days: 31, title: 'Узел Pro на месяц' },
  pro_year: { tier: 'pro', amount: '1490.00', days: 366, title: 'Узел Pro на год' },
  business_month: { tier: 'business', amount: '599.00', days: 31, title: 'Узел Бизнес на месяц' },
  business_year: { tier: 'business', amount: '4990.00', days: 366, title: 'Узел Бизнес на год' },
};
// Путь страниц: /p/<имя>. Так остаётся место под другие разделы сайта.
const PAGE_PREFIX = '/p';
function planOf(u) {
  return u && (u.plan === 'pro' || u.plan === 'business') && (!u.plan_until || new Date(u.plan_until).getTime() > Date.now()) ? u.plan : 'free';
}
const RESERVED = new Set(['p', 'en', 'pricing', 'examples', 'guides', 'plan', 'profile', 'links', 'design', 'stats', 'form', 'inbox', 'security', 'preview', 'start', 'more', 'lead', 'qr', 'sitemap', 'app', 'api', 'admin', 'assets', 'go', 'media', 'report', 'rules', 'privacy', 'login', 'logout', 'static', 'www', 'mail', 'help', 'support', 'antviz', 'uzel', 'about', 'terms', 'status', 'blog', 'robots', 'sitemap', 'favicon', 'index', 'dashboard', 'settings', 'me', 'null', 'undefined', 'test', 'root', 'system', 'security', 'billing', 'pay', 'official']);

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
ALTER TABLE uzel_users ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE uzel_users ADD COLUMN IF NOT EXISTS plan_until TIMESTAMPTZ;
ALTER TABLE uzel_users ADD COLUMN IF NOT EXISTS digest BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE uzel_users ADD COLUMN IF NOT EXISTS digest_sent_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS uzel_leads (
    id         BIGSERIAL PRIMARY KEY,
    page_id    BIGINT NOT NULL REFERENCES uzel_pages(id) ON DELETE CASCADE,
    name       TEXT NOT NULL DEFAULT '',
    contact    TEXT NOT NULL,
    message    TEXT NOT NULL DEFAULT '',
    ip         TEXT,
    is_read    BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_uzel_leads_page ON uzel_leads(page_id, created_at DESC);
CREATE TABLE IF NOT EXISTS uzel_payments (
    id         TEXT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES uzel_users(id) ON DELETE CASCADE,
    plan_code  TEXT NOT NULL,
    amount     TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at    TIMESTAMPTZ
);
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

function validatePage(input, existing, plan) {
  plan = plan === 'pro' || plan === 'business' ? plan : 'free';
  const paid = plan !== 'free';
  const lim = LIMITS[plan];
  const errors = [];
  const out = {};
  const name = cleanText(input.name, 60);
  if (!name) errors.push('Укажите имя');
  out.name = name;
  out.subtitle = cleanText(input.subtitle, 80);
  out.bio = cleanText(input.bio, 300);
  const wantTheme = THEMES.includes(input.theme) ? input.theme : (existing ? existing.theme : 'light');
  if (!lim.themes.includes(wantTheme) && !(existing && existing.theme === wantTheme)) {
    errors.push('Эта тема доступна в Pro');
    out.theme = existing && lim.themes.includes(existing.theme) ? existing.theme : 'light';
  } else out.theme = wantTheme;
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
  const lang = LANGS.includes(input.lang) ? input.lang : (oldExt.lang || 'ru');
  const fi = input.form && typeof input.form === 'object' ? input.form : (oldExt.form || {});
  let hook = fi.webhook === undefined ? (oldExt.form && oldExt.form.webhook) || '' : String(fi.webhook || '').trim();
  if (hook) {
    let u = null; try { u = new URL(hook); } catch (e) { /* ниже */ }
    if (!u || u.protocol !== 'https:' || u.port || u.username || u.password || hook.length > 300) { errors.push('Вебхук: нужен адрес вида https://… без порта и логина'); hook = (oldExt.form && oldExt.form.webhook) || ''; }
    else if (!paid && hook !== ((oldExt.form && oldExt.form.webhook) || '')) { errors.push('Вебхук доступен в Pro'); hook = (oldExt.form && oldExt.form.webhook) || ''; }
  }
  const secret = (oldExt.form && oldExt.form.secret) || require('crypto').randomBytes(18).toString('hex');
  const form = { webhook: hook, secret, enabled: !!fi.enabled, title: cleanText(fi.title, 60) || (lang === 'en' ? 'Leave a request' : 'Оставить заявку'), button: cleanText(fi.button, 30) || (lang === 'en' ? 'Send' : 'Отправить'), notify: fi.notify !== false };
  const hideBadge = input.hideBadge === undefined ? !!oldExt.hideBadge : !!input.hideBadge;
  if (hideBadge && !paid && !oldExt.hideBadge) errors.push('Скрыть значок можно в Pro');
  const inAcc = input.accent === undefined ? undefined : String(input.accent || '').trim().toLowerCase();
  let accent = oldExt.accent || '';
  if (inAcc !== undefined && inAcc !== accent) {
    if (inAcc && !/^#[0-9a-f]{6}$/.test(inAcc)) errors.push('Цвет нужен в формате #0066ff');
    else if (inAcc && plan !== 'business') errors.push('Свой цвет кнопок доступен в тарифе Бизнес');
    else accent = inAcc;
  }
  out.ext = { shape, info, lang, form, hideBadge: hideBadge && (paid || !!oldExt.hideBadge), accent };

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
  const rawLinks = Array.isArray(input.links) ? input.links.filter(Boolean) : [];
  const prevCount = existing && Array.isArray(existing.links) ? existing.links.length : 0;
  if (rawLinks.length > lim.links && rawLinks.length > prevCount) errors.push(plan === 'free' ? `На бесплатном тарифе до ${lim.links} ссылок, в Pro до ${LIMITS.pro.links}` : plan === 'pro' ? `В Pro до ${lim.links} ссылок, в Бизнес до ${LIMITS.business.links}` : `Не больше ${lim.links} ссылок`);
  for (const l of rawLinks.slice(0, LIMITS.business.links)) {
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
    const sched = {};
    for (const k of ['from', 'to']) {
      if (l[k]) {
        const t = Date.parse(l[k]);
        if (Number.isNaN(t)) { errors.push(`Проверьте дату у ссылки «${title}»`); continue; }
        const iso = new Date(t).toISOString();
        const prev = existing && Array.isArray(existing.links) ? existing.links.find((x) => x.id === l.id) : null;
        if (!paid && !(prev && prev[k] === iso)) { errors.push('Показ по расписанию доступен в Pro'); continue; }
        sched[k] = iso;
      }
    }
    links.push(Object.assign({ id, title, url, enabled: l.enabled !== false }, desc ? { desc } : {}, sched));
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
h1,.sub,.bio,.lk span{overflow-wrap:anywhere;word-break:break-word;min-width:0}.bio{max-width:100%;white-space:pre-line}
.lk small{display:block;font-weight:500;font-size:13px;opacity:.7;margin-top:2px;white-space:normal}
.lk .hd{font:800 13px Unbounded,"Golos Text",sans-serif;letter-spacing:.02em;text-transform:uppercase;opacity:.6;margin:14px 0 -2px;text-align:left}
.fm{width:100%;display:flex;flex-direction:column;gap:10px;margin-top:22px;text-align:left}.fm input,.fm textarea{width:100%;border:0;border-radius:16px;padding:14px 16px;font:600 16px "Golos Text",system-ui,sans-serif;color:inherit;background:#0b0b0d12;outline:2px solid transparent}.fm textarea{resize:vertical;min-height:84px;max-height:200px}.fm input::placeholder,.fm textarea::placeholder{color:inherit;opacity:.55}.fm input:focus,.fm textarea:focus{outline-color:currentColor}.fm button{height:54px;border:0;border-radius:18px;font:800 16px "Golos Text",system-ui,sans-serif;cursor:pointer;background:#0b0b0d;color:#fff}.t-dark .fm button,.t-graphite .fm button,.t-blue .fm button,.t-sunset .fm button{background:#fff;color:#0b0b0d}.fm .hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.t-dark .fm input,.t-dark .fm textarea,.t-blue .fm input,.t-blue .fm textarea,.t-sunset .fm input,.t-sunset .fm textarea,.t-graphite .fm input,.t-graphite .fm textarea{background:#ffffff1f}
.ac .lk a,.ac .ct a{background:var(--ac)!important;color:var(--act)!important;box-shadow:none!important}.ac .fm button{background:var(--ac)!important;color:var(--act)!important}
.s-round .lk a{border-radius:999px}.s-square .lk a{border-radius:6px}.s-square .soc a{border-radius:8px}
`;

const L10N = {
  ru: { call: 'Позвонить', mail: 'Написать', route: 'Как добраться', made: 'Сделано на Узле', report: 'Пожаловаться', name: 'Ваше имя', contact: 'Телефон или почта', msg: 'Сообщение (необязательно)', pageOf: (n) => `Страница ${n} на Узле` },
  en: { call: 'Call', mail: 'Email', route: 'Directions', made: 'Made with Uzel', report: 'Report', name: 'Your name', contact: 'Phone or email', msg: 'Message (optional)', pageOf: (n) => `${n} on Uzel` },
};
const pageUrl = (origin, slug) => `${origin}${BASE}${PAGE_PREFIX}/${slug}`;
const linkLive = (l, now) => (!l.from || Date.parse(l.from) <= now) && (!l.to || Date.parse(l.to) > now);

function renderPublicPage(page, origin, opts) {
  opts = opts || {};
  const ext = page.ext || {};
  const L = L10N[ext.lang] || L10N.ru;
  const t = THEMES.includes(page.theme) ? page.theme : 'light';
  const plan = opts.plan || 'free';
  const now = Date.now();
  const go = (id) => (opts.preview ? '#' : `/api/uzel/go/${esc(page.slug)}/${id}`);
  const avatar = page.avatar
    ? `<img src="/api/uzel/media/${esc(page.avatar)}" alt="" width="112" height="112">`
    : esc(initials(page.name));
  const soc = (page.socials || []).filter((s) => icons.brands[s.type]).map((s) => `<a href="${go('s-' + esc(s.type))}" rel="nofollow noopener ugc" aria-label="${esc(SOCIALS[s.type] ? SOCIALS[s.type].label : s.type)}">${brandSvg(s.type)}</a>`).join('');
  const arrow = lucideSvg('arrow-up-right').replace('<svg', '<svg class="ar"');
  const links = (page.links || []).filter((l) => l.enabled !== false && (plan === 'free' || linkLive(l, now))).map((l) => l.kind === 'header' ? `<h2 class="hd">${esc(l.title)}</h2>` : `<a href="${go(esc(l.id))}" rel="nofollow noopener ugc">${lucideSvg('link')}<span>${esc(l.title)}${l.desc ? `<small>${esc(l.desc)}</small>` : ''}</span>${arrow}</a>`).join('');
  const info = ext.info || {};
  const infoBtns = [info.phone ? ['i-phone', 'phone', L.call] : null, info.email ? ['i-email', 'mail', L.mail] : null, info.address ? ['i-map', 'map-pin', L.route] : null].filter(Boolean)
    .map(([id, ic, tx]) => `<a href="${go(id)}" rel="nofollow noopener ugc">${lucideSvg(ic)}<span>${tx}</span></a>`).join('');
  const shape = ext.shape || 'soft';
  const music = page.music ? `<a href="${go('music')}" rel="nofollow noopener ugc">${lucideSvg('music')}<span>${esc(page.music.title)}</span>${arrow}</a>` : '';
  const f = ext.form || {};
  const form = f.enabled ? `<form class="fm" method="post" action="${opts.preview ? '#' : '/api/uzel/lead/' + esc(page.slug)}" ${opts.preview ? 'onsubmit="return false"' : ''}><h2 class="hd" style="margin:0 0 4px">${esc(f.title)}</h2><input name="name" maxlength="60" placeholder="${L.name}" autocomplete="name"><input name="contact" maxlength="120" required placeholder="${L.contact}" autocomplete="tel"><textarea name="message" maxlength="600" rows="3" placeholder="${L.msg}"></textarea><input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="submit">${esc(f.button)}</button></form>` : '';
  const desc = esc(page.bio || page.subtitle || L.pageOf(page.name));
  const img = page.avatar ? `<meta property="og:image" content="${esc(origin)}/api/uzel/media/${esc(page.avatar)}">` : '';
  let accentCss = '';
  if (plan === 'business' && /^#[0-9a-f]{6}$/.test(ext.accent || '')) {
    const n = parseInt(ext.accent.slice(1), 16), lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    accentCss = `--ac:${ext.accent};--act:${lum > 0.62 ? '#0b0b0d' : '#ffffff'}`;
  }
  const badge = ext.hideBadge && plan !== 'free' ? '' : `<a href="${esc(origin)}${BASE}/">${L.made}</a>`;
  return `<!doctype html><html lang="${ext.lang === 'en' ? 'en' : 'ru'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(page.name)} · Узел</title><meta name="description" content="${desc}"><meta name="robots" content="noindex,nofollow">
<meta property="og:title" content="${esc(page.name)}"><meta property="og:description" content="${desc}"><meta property="og:type" content="profile">${img}
<meta name="theme-color" content="${({ dark: '#0b0b0d', blue: '#0055e0', warm: '#ffe9d6', mint: '#dff5e8', sunset: '#c2255c', graphite: '#26272b', lilac: '#ece6ff' })[t] || '#f2f2f4'}">
<link rel="icon" href="${BASE}/assets/favicon.svg" type="image/svg+xml"><style>${PAGE_CSS}</style></head>
<body class="t-${t} s-${shape}${accentCss ? ' ac' : ''}"${accentCss ? ` style="${accentCss}"` : ''}><main class="w"><div class="av" style="background:${gradient(page.name)}">${avatar}</div><h1>${esc(page.name)}</h1>${page.subtitle ? `<p class="sub">${esc(page.subtitle)}</p>` : ''}${page.bio ? `<p class="bio">${esc(page.bio)}</p>` : ''}${soc ? `<div class="soc">${soc}</div>` : ''}${infoBtns ? `<div class="ct">${infoBtns}</div>` : ''}<div class="lk">${links}${music}</div>${form}
<div class="ft">${badge}<a href="${opts.preview ? '#' : '/api/uzel/report/' + esc(page.slug)}">${L.report}</a></div></main></body></html>`;
}

function simplePage(title, body, status) {
  return { status: status || 200, html: `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Узел</title><style>${PAGE_CSS}.card{background:#fff;border-radius:28px;padding:30px;box-shadow:0 0 0 1px #0b0b0d1a;text-align:left;width:100%}.card h1{font-size:26px;margin:0 0 12px}.card p{margin:0 0 14px;color:#4a474b}.card select,.card textarea{width:100%;border:0;background:#f2f2f4;border-radius:16px;padding:14px 16px;font:inherit;margin-bottom:12px}.card button,.card .b{display:inline-flex;align-items:center;height:52px;padding:0 24px;border-radius:16px;border:0;background:#06f;color:#fff;font:700 17px inherit;text-decoration:none;cursor:pointer}</style></head><body class="t-light"><main class="w"><div class="card">${body}</div></main></body></html>` };
}

module.exports = { LIMITS, FREE_THEMES, LANGS, PLAN_PRICES, PAGE_PREFIX, planOf, pageUrl, SHAPES, BASE, ensureUzelTables, cleanupUzel, THEMES, RESERVED, SOCIALS, cleanText, validateSlug, normalizeUrl, normalizeSocial, validatePage, newId, renderPublicPage, simplePage, esc };
