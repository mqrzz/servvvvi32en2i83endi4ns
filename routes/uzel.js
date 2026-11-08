const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const pool = require('../db/pool');
const U = require('../utils/uzel');
const mailer = require('../utils/mailer');
const { sendWebhook } = require('../utils/uzel-hooks');
const { transporter } = mailer;
const { cleanIp, deviceClass } = require('../utils/analytics');

const router = express.Router();

const COOKIE = 'uzel_session';
const SESSION_DAYS = 30;
const PEPPER = process.env.UZEL_PEPPER || process.env.JWT_SECRET || 'uzel';
const ORIGIN = process.env.UZEL_ORIGIN || 'https://antviz.ru';
const DEV = process.env.UZEL_INSECURE_COOKIE === '1';
const { buildReceipt } = require('../utils/receipt');
const YK_API = process.env.YOOKASSA_API || 'https://api.yookassa.ru/v3';
const ykOn = () => !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY);
const ykAuth = () => 'Basic ' + Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
const UPLOAD_DIR = process.env.UZEL_UPLOAD_DIR || path.join(__dirname, '..', 'uploads', 'uzel');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const codeHash = (email, code) => sha(`${code}:${email}:${PEPPER}`);

function limiter(windowMs, max, message) {
  return rateLimit({ windowMs, max, message: { error: message || 'Слишком много запросов, попробуйте позже' }, standardHeaders: true, legacyHeaders: false });
}

/* ---------- защита от CSRF для изменяющих запросов ---------- */
function csrf(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.path.startsWith('/report') || req.path.startsWith('/lead') || req.path.startsWith('/pay')) return next();
  if (req.get('x-requested-with') !== 'uzel') return res.status(403).json({ error: 'Запрос отклонён' });
  const origin = req.get('origin');
  if (origin && origin !== ORIGIN && !(DEV && /^http:\/\/localhost(:\d+)?$/.test(origin))) {
    return res.status(403).json({ error: 'Запрос отклонён' });
  }
  next();
}
router.use(csrf);

/* ---------- сессии ---------- */
function setCookie(res, token) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: !DEV, sameSite: 'lax', maxAge: SESSION_DAYS * 86400 * 1000, path: '/' });
}

function parseUa(ua) {
  ua = String(ua || '');
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /YaBrowser/.test(ua) ? 'Яндекс Браузер' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  const o = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b}, ${o}` : b;
}
const maskIp = (ip) => {
  ip = String(ip || '');
  if (ip.includes('.')) return ip.split('.').slice(0, 2).join('.') + '.•.•';
  return ip.split(':').slice(0, 2).join(':') + ':•••';
};

async function loadSession(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await pool.query(
    `SELECT s.id AS sid, s.last_seen_at, u.id, u.email, u.name, u.banned, u.plan, u.plan_until
     FROM uzel_sessions s JOIN uzel_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)]
  );
  if (!rows.length || rows[0].banned) return null;
  const r = rows[0];
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60 * 1000) {
    pool.query('UPDATE uzel_sessions SET last_seen_at = now() WHERE id = $1', [r.sid]).catch(() => {});
  }
  return { sid: Number(r.sid), user: { id: Number(r.id), email: r.email, name: r.name, plan: U.planOf(r), plan_until: r.plan_until } };
}

async function needUser(req, res, next) {
  try {
    const s = await loadSession(req);
    if (!s) return res.status(401).json({ error: 'Нужно войти' });
    req.uz = s;
    next();
  } catch (err) {
    console.error('uzel/auth:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
}

/* ---------- вход по коду ---------- */
const emailRe = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[A-Za-z]{2,}$/;

router.post('/auth/send-code', limiter(60 * 60 * 1000, 20, 'Слишком много запросов кода. Попробуйте через час.'), async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!emailRe.test(email) || email.length > 254) return res.status(400).json({ error: 'Проверьте адрес почты' });

    const recent = await pool.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour,
              max(created_at) AS last FROM uzel_codes WHERE email = $1`,
      [email]
    );
    const r = recent.rows[0];
    if (r.last && Date.now() - new Date(r.last).getTime() < 45 * 1000) return res.json({ ok: true, wait: 45 });
    if (r.hour >= 5) return res.json({ ok: true }); // не выдаём лишнего и не шлём письма

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await pool.query(
      `INSERT INTO uzel_codes (email, code_hash, ip, expires_at) VALUES ($1,$2,$3,now() + interval '10 minutes')`,
      [email, codeHash(email, code), cleanIp(req.ip)]
    );
    if (process.env.UZEL_DEV_LOG_CODES === '1') console.log(`[uzel dev] код для ${email}: ${code}`);
    try {
      const lang = req.body && req.body.lang === 'en' ? 'en' : 'ru';
      const mail = mailer.uzelCodeEmail({ code, lang, email });
      await transporter.sendMail({ from: process.env.MAIL_FROM, to: email, subject: mail.subject, html: mail.html, text: mail.text, attachments: mail.attachments });
    } catch (mailErr) {
      console.error('uzel/send-code: письмо не отправлено:', mailErr.message);
      if (process.env.UZEL_DEV_LOG_CODES !== '1') return res.status(502).json({ error: 'Не удалось отправить письмо. Попробуйте позже.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('uzel/send-code:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.post('/auth/verify', limiter(15 * 60 * 1000, 40, 'Слишком много попыток. Подождите.'), async (req, res) => {
  const client = await pool.connect();
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
    if (!emailRe.test(email) || code.length !== 6) return res.status(400).json({ error: 'Неверный код' });

    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, code_hash, attempts FROM uzel_codes WHERE email = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email]
    );
    if (!rows.length || rows[0].attempts >= 5) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Код недействителен. Запросите новый.' });
    }
    const row = rows[0];
    const a = Buffer.from(row.code_hash), b = Buffer.from(codeHash(email, code));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      await client.query('UPDATE uzel_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return res.status(400).json({ error: 'Неверный код' });
    }
    await client.query('UPDATE uzel_codes SET used = true WHERE id = $1', [row.id]);
    const u = await client.query(
      `INSERT INTO uzel_users (email, last_login_at) VALUES ($1, now())
       ON CONFLICT (email) DO UPDATE SET last_login_at = now() RETURNING id, email, name, banned`,
      [email]
    );
    if (u.rows[0].banned) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Аккаунт заблокирован' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await client.query(
      `INSERT INTO uzel_sessions (user_id, token_hash, ua, ip, expires_at) VALUES ($1,$2,$3,$4, now() + ($5::int * interval '1 day'))`,
      [u.rows[0].id, sha(token), String(req.get('user-agent') || '').slice(0, 300), cleanIp(req.ip), SESSION_DAYS]
    );
    await client.query('COMMIT');
    setCookie(res, token);
    res.json({ ok: true, user: { email: u.rows[0].email, name: u.rows[0].name } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('uzel/verify:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

router.post('/auth/logout', needUser, async (req, res) => {
  await pool.query('DELETE FROM uzel_sessions WHERE id = $1', [req.uz.sid]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.post('/auth/logout-all', needUser, async (req, res) => {
  await pool.query('DELETE FROM uzel_sessions WHERE user_id = $1', [req.uz.user.id]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

/* ---------- профиль и страница ---------- */
function pageOut(p) {
  return p && { id: Number(p.id), slug: p.slug, name: p.name, subtitle: p.subtitle, bio: p.bio, avatar: p.avatar, theme: p.theme, socials: p.socials, links: p.links, music: p.music, ext: p.ext || {}, url: U.pageUrl(ORIGIN, p.slug), published: p.published, hidden: p.hidden };
}

router.get('/me', needUser, async (req, res) => {
  try {
    const [p, s, unread, digestRow] = await Promise.all([
      pool.query('SELECT * FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]),
      pool.query('SELECT id, ua, ip, created_at, last_seen_at FROM uzel_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC', [req.uz.user.id]),
      pool.query('SELECT count(*)::int AS n FROM uzel_leads l JOIN uzel_pages p ON p.id = l.page_id WHERE p.user_id = $1 AND NOT l.is_read', [req.uz.user.id]),
      pool.query('SELECT digest FROM uzel_users WHERE id = $1', [req.uz.user.id]),
    ]);
    res.json({
      user: req.uz.user,
      page: pageOut(p.rows[0]),
      sessions: s.rows.map((r) => ({ id: Number(r.id), device: parseUa(r.ua), ip: maskIp(r.ip), created_at: r.created_at, last_seen_at: r.last_seen_at, current: Number(r.id) === req.uz.sid })),
      origin: ORIGIN,
      pageBase: `${ORIGIN}${U.BASE}${U.PAGE_PREFIX}/`,
      plan: { code: req.uz.user.plan, paid: req.uz.user.plan !== 'free', business: req.uz.user.plan === 'business', until: req.uz.user.plan_until, limits: U.LIMITS[req.uz.user.plan], free: U.LIMITS.free, pro: U.LIMITS.pro, businessLimits: U.LIMITS.business, prices: U.PLAN_PRICES, pay: ykOn() },
      unread: unread.rows[0] ? unread.rows[0].n : 0,
      digest: !!digestRow.rows[0].digest,
    });
  } catch (err) {
    console.error('uzel/me:', err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.get('/slug/check', limiter(60 * 1000, 60), async (req, res) => {
  try {
    const v = U.validateSlug(req.query.slug);
    if (!v.ok) return res.json({ available: false, reason: v.reason });
    const { rows } = await pool.query('SELECT user_id FROM uzel_pages WHERE slug = $1', [v.slug]);
    let mine = false;
    if (rows.length) {
      const s = await loadSession(req).catch(() => null);
      mine = !!(s && Number(rows[0].user_id) === s.user.id);
    }
    res.json({ available: !rows.length || mine, mine, reason: rows.length && !mine ? 'Адрес занят' : '' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.put('/me/page', needUser, limiter(60 * 1000, 60), async (req, res) => {
  try {
    const cur = await pool.query('SELECT * FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    const existing = cur.rows[0];
    const body = Object.assign({}, req.body || {});
    if (existing) {
      const e = existing.ext || {};
      const base = { name: existing.name, subtitle: existing.subtitle, bio: existing.bio, theme: existing.theme, published: existing.published,
        socials: (existing.socials || []).map((x) => ({ type: x.type, value: x.url })), links: existing.links || [], music: existing.music,
        shape: e.shape, info: e.info, lang: e.lang, form: e.form, hideBadge: e.hideBadge };
      for (const k of Object.keys(base)) if (body[k] === undefined) body[k] = base[k];
    }
    const v = U.validatePage(body, existing, req.uz.user.plan);
    if (!v.ok) return res.status(400).json({ error: v.errors[0], errors: v.errors });
    const d = v.data;

    let slug = existing ? existing.slug : null;
    const wanted = req.body && req.body.slug != null ? String(req.body.slug) : null;
    if (wanted !== null && (!existing || wanted.toLowerCase() !== existing.slug)) {
      const sv = U.validateSlug(wanted);
      if (!sv.ok) return res.status(400).json({ error: sv.reason });
      slug = sv.slug;
    }
    if (!slug) return res.status(400).json({ error: 'Выберите адрес страницы' });

    try {
      let row;
      if (existing) {
        row = await pool.query(
          `UPDATE uzel_pages SET slug=$2, name=$3, subtitle=$4, bio=$5, theme=$6, socials=$7, links=$8, music=$9, published=$10, ext=$11, updated_at=now()
           WHERE user_id=$1 RETURNING *`,
          [req.uz.user.id, slug, d.name, d.subtitle, d.bio, d.theme, JSON.stringify(d.socials), JSON.stringify(d.links), d.music ? JSON.stringify(d.music) : null, d.published, JSON.stringify(d.ext || {})]
        );
      } else {
        row = await pool.query(
          `INSERT INTO uzel_pages (user_id, slug, name, subtitle, bio, theme, socials, links, music, published, ext)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [req.uz.user.id, slug, d.name, d.subtitle, d.bio, d.theme, JSON.stringify(d.socials), JSON.stringify(d.links), d.music ? JSON.stringify(d.music) : null, d.published, JSON.stringify(d.ext || {})]
        );
      }
      await pool.query('UPDATE uzel_users SET name = $2 WHERE id = $1', [req.uz.user.id, d.name]);
      res.json({ ok: true, page: pageOut(row.rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Этот адрес уже занят' });
      throw err;
    }
  } catch (err) {
    console.error('uzel/page:', err);
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

router.post('/me/avatar', needUser, limiter(60 * 1000, 10), async (req, res) => {
  try {
    const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body && req.body.data) || ''));
    if (!m) return res.status(400).json({ error: 'Загрузите изображение PNG, JPG или WebP' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: 'Файл больше 6 МБ' });
    const cur = await pool.query('SELECT id, avatar FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    if (!cur.rows.length) return res.status(400).json({ error: 'Сначала создайте страницу' });
    let out;
    try {
      out = await sharp(buf, { limitInputPixels: 40e6 }).rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
    } catch {
      return res.status(400).json({ error: 'Не удалось прочитать изображение' });
    }
    const file = crypto.randomBytes(12).toString('hex') + '.webp';
    fs.writeFileSync(path.join(UPLOAD_DIR, file), out);
    await pool.query('UPDATE uzel_pages SET avatar = $2, updated_at = now() WHERE id = $1', [cur.rows[0].id, file]);
    if (cur.rows[0].avatar) fs.unlink(path.join(UPLOAD_DIR, cur.rows[0].avatar), () => {});
    res.json({ ok: true, avatar: file });
  } catch (err) {
    console.error('uzel/avatar:', err);
    res.status(500).json({ error: 'Не удалось загрузить фото' });
  }
});

router.delete('/me/avatar', needUser, async (req, res) => {
  const cur = await pool.query('UPDATE uzel_pages SET avatar = NULL WHERE user_id = $1 RETURNING (SELECT avatar FROM uzel_pages WHERE user_id = $1) AS old', [req.uz.user.id]);
  if (cur.rows[0] && cur.rows[0].old) fs.unlink(path.join(UPLOAD_DIR, cur.rows[0].old), () => {});
  res.json({ ok: true });
});

router.delete('/sessions/:id', needUser, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id === req.uz.sid) return res.status(400).json({ error: 'Нельзя завершить текущую сессию, используйте «Выйти»' });
  await pool.query('DELETE FROM uzel_sessions WHERE id = $1 AND user_id = $2', [id, req.uz.user.id]);
  res.json({ ok: true });
});

router.delete('/me', needUser, async (req, res) => {
  try {
    const p = await pool.query('SELECT avatar FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    await pool.query('DELETE FROM uzel_users WHERE id = $1', [req.uz.user.id]);
    if (p.rows[0] && p.rows[0].avatar) fs.unlink(path.join(UPLOAD_DIR, p.rows[0].avatar), () => {});
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  } catch (err) {
    console.error('uzel/delete:', err);
    res.status(500).json({ error: 'Не удалось удалить аккаунт' });
  }
});

router.get('/me/export', needUser, async (req, res) => {
  const p = await pool.query('SELECT slug, name, subtitle, bio, theme, socials, links, music, ext, published, created_at FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
  res.setHeader('Content-Disposition', 'attachment; filename="uzel-data.json"');
  res.json({ user: req.uz.user, page: p.rows[0] || null });
});

router.get('/me/stats', needUser, async (req, res) => {
  try {
    const days = Math.min(U.LIMITS[req.uz.user.plan].statsDays, Math.max(1, parseInt(req.query.days, 10) || 14));
    const p = await pool.query('SELECT id, links, socials, music FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    if (!p.rows.length) return res.json({ days, series: [], totals: { views: 0, clicks: 0 }, links: [], refs: [] });
    const page = p.rows[0], id = page.id;
    const since = `now() - ($2::int * interval '1 day')`;
    const [series, totals, links, refs, devs, leadsN] = await Promise.all([
      pool.query(
        `SELECT to_char(d::date,'YYYY-MM-DD') AS day, COALESCE(v.views,0)::int AS views, COALESCE(v.clicks,0)::int AS clicks
         FROM generate_series((now() AT TIME ZONE 'Europe/Moscow')::date - ($2::int - 1), (now() AT TIME ZONE 'Europe/Moscow')::date, interval '1 day') d
         LEFT JOIN (SELECT (ts AT TIME ZONE 'Europe/Moscow')::date AS day, count(*) FILTER (WHERE kind='view') AS views, count(*) FILTER (WHERE kind='click') AS clicks
                    FROM uzel_events WHERE page_id = $1 AND ts > ${since} GROUP BY 1) v ON v.day = d::date ORDER BY d`, [id, days]),
      pool.query(`SELECT count(*) FILTER (WHERE kind='view')::int AS views, count(*) FILTER (WHERE kind='click')::int AS clicks FROM uzel_events WHERE page_id = $1 AND ts > ${since}`, [id, days]),
      pool.query(`SELECT link_id, count(*)::int AS clicks FROM uzel_events WHERE page_id = $1 AND kind='click' AND ts > ${since} GROUP BY 1 ORDER BY clicks DESC`, [id, days]),
      pool.query(`SELECT COALESCE(ref,'Прямые заходы') AS ref, count(*)::int AS views FROM uzel_events WHERE page_id = $1 AND kind='view' AND ts > ${since} GROUP BY 1 ORDER BY views DESC LIMIT 8`, [id, days]),
      pool.query(`SELECT COALESCE(device,'desktop') AS device, count(*)::int AS views FROM uzel_events WHERE page_id = $1 AND kind='view' AND ts > ${since} GROUP BY 1 ORDER BY views DESC`, [id, days]),
      pool.query(`SELECT count(*)::int AS n FROM uzel_leads WHERE page_id = $1 AND created_at > ${since}`, [id, days]),
    ]);
    const names = {};
    (page.links || []).forEach((l) => { names[l.id] = l.title; });
    (page.socials || []).forEach((s) => { names['s-' + s.type] = (U.SOCIALS[s.type] || {}).label || s.type; });
    names['i-phone'] = 'Позвонить'; names['i-email'] = 'Написать'; names['i-map'] = 'Как добраться';
    if (page.music) names.music = 'Музыка: ' + page.music.title;
    res.json({ days, maxDays: U.LIMITS[req.uz.user.plan].statsDays, devices: devs.rows, leads: leadsN.rows[0].n, series: series.rows, totals: totals.rows[0], links: links.rows.map((r) => ({ title: names[r.link_id] || 'Удалённая ссылка', clicks: r.clicks })), refs: refs.rows });
  } catch (err) {
    console.error('uzel/stats:', err);
    res.status(500).json({ error: 'Не удалось получить статистику' });
  }
});

/* ---------- публичные маршруты ---------- */
function refHost(ref) {
  try {
    if (!ref) return null;
    const h = new URL(String(ref)).hostname.replace(/^www\./, '').toLowerCase();
    return h && !/(^|\.)antviz\.ru$/.test(h) ? h.slice(0, 80) : null;
  } catch { return null; }
}
const SEC = {
  'Content-Security-Policy': `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

router.get('/render/:slug', limiter(60 * 1000, 120), async (req, res) => {
  res.set(SEC);
  try {
    const v = U.validateSlug(req.params.slug);
    const { rows } = v.ok ? await pool.query('SELECT p.*, u.plan AS owner_plan, u.plan_until AS owner_until FROM uzel_pages p JOIN uzel_users u ON u.id = p.user_id WHERE p.slug = $1', [v.slug]) : { rows: [] };
    const page = rows[0];
    if (page) page.owner = U.planOf({ plan: page.owner_plan, plan_until: page.owner_until });
    if (!page || !page.published || page.hidden) {
      const s = U.simplePage('Страница не найдена', `<h1>Здесь пока пусто</h1><p>${page && page.hidden ? 'Страница недоступна.' : 'Такой страницы нет. Возможно, адрес свободен.'}</p><a class="b" href="${ORIGIN}/app/">Создать свою страницу</a>`, 404);
      return res.status(s.status).type('html').send(s.html);
    }
    if (req.get('x-uzel-subdomain') === '1') {
      if (page.owner === 'free') {
        const s = U.simplePage('Поддомен недоступен', `<h1>Поддомен недоступен</h1><p>Адреса вида имя.домен входят в тариф Pro. Страница доступна по обычной ссылке.</p><a class="b" href="${U.pageUrl(ORIGIN, page.slug)}">Открыть страницу</a>`, 404);
        return res.status(s.status).type('html').send(s.html);
      }
    }
    const dev = deviceClass(req.get('user-agent'));
    if (dev !== 'bot' && req.get('dnt') !== '1') {
      const utm = U.cleanText(req.query.utm_source || req.query.ref || '', 40).toLowerCase().replace(/[^a-z0-9а-я._-]/g, '');
      pool.query('INSERT INTO uzel_events (page_id, kind, ref, device) VALUES ($1,$2,$3,$4)', [page.id, 'view', utm ? 'метка: ' + utm : refHost(req.get('referer')), dev]).catch(() => {});
    }
    res.set('Cache-Control', 'no-store').type('html').send(U.renderPublicPage(page, ORIGIN, { plan: page.owner }));
  } catch (err) {
    console.error('uzel/render:', err);
    res.status(500).type('text').send('Ошибка сервера');
  }
});

router.get('/go/:slug/:id', limiter(60 * 1000, 120), async (req, res) => {
  try {
    const v = U.validateSlug(req.params.slug);
    const { rows } = v.ok ? await pool.query('SELECT * FROM uzel_pages WHERE slug = $1 AND published AND NOT hidden', [v.slug]) : { rows: [] };
    const page = rows[0];
    const id = String(req.params.id);
    let url = null;
    if (page) {
      const inf = (page.ext && page.ext.info) || {};
      if (id === 'i-phone' && inf.phone) url = 'tel:' + inf.phone;
      else if (id === 'i-email' && inf.email) url = 'mailto:' + inf.email;
      else if (id === 'i-map' && inf.address) url = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(inf.address);
      else if (id === 'music') url = page.music && page.music.url;
      else if (id.startsWith('s-')) { const s = (page.socials || []).find((x) => 's-' + x.type === id); url = s && s.url; }
      else { const l = (page.links || []).find((x) => x.id === id && x.enabled !== false); url = l && l.url; }
    }
    if (!url || !(/^(tel|mailto):/.test(url) || U.normalizeUrl(url))) return res.status(404).type('text').send('Ссылка не найдена');
    const dev = deviceClass(req.get('user-agent'));
    if (dev !== 'bot') pool.query('INSERT INTO uzel_events (page_id, kind, link_id, device) VALUES ($1,$2,$3,$4)', [page.id, 'click', id.slice(0, 20), dev]).catch(() => {});
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }).redirect(302, url);
  } catch (err) {
    res.status(500).type('text').send('Ошибка сервера');
  }
});

router.get('/qr/:slug', limiter(60 * 1000, 60), async (req, res) => {
  try {
    const v = U.validateSlug(req.params.slug);
    const { rows } = v.ok ? await pool.query('SELECT slug FROM uzel_pages WHERE slug = $1 AND published AND NOT hidden', [v.slug]) : { rows: [] };
    if (!rows[0]) return res.status(404).type('text').send('Страница не найдена');
    const svg = await require('qrcode').toString(U.pageUrl(ORIGIN, rows[0].slug), { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0b0b0d', light: '#ffffff' } });
    res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    if (req.query.dl) res.set('Content-Disposition', `attachment; filename="uzel-${rows[0].slug}.svg"`);
    res.send(svg);
  } catch (err) {
    res.status(500).type('text').send('Ошибка сервера');
  }
});

router.get('/media/:file', (req, res) => {
  const f = String(req.params.file);
  if (!/^[a-f0-9]{24}\.webp$/.test(f)) return res.status(404).end();
  const p = path.join(UPLOAD_DIR, f);
  if (!fs.existsSync(p)) return res.status(404).end();
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Type': 'image/webp' }).sendFile(p);
});

router.get('/report/:slug', async (req, res) => {
  res.set(SEC);
  const v = U.validateSlug(req.params.slug);
  const slug = v.ok ? v.slug : '';
  const s = U.simplePage('Жалоба', `<h1>Пожаловаться на страницу</h1><p>Страница: <b>${U.esc(slug)}</b></p><form method="post" action="/api/uzel/report"><input type="hidden" name="slug" value="${U.esc(slug)}"><select name="reason"><option>Мошенничество или обман</option><option>Оскорбления или угрозы</option><option>Запрещённый контент</option><option>Чужие персональные данные</option><option>Другое</option></select><textarea name="details" rows="4" maxlength="500" placeholder="Что не так (необязательно)"></textarea><button type="submit">Отправить жалобу</button></form>`);
  res.type('html').send(s.html);
});

router.post('/report', limiter(60 * 60 * 1000, 8, 'Слишком много жалоб с вашего адреса'), express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  res.set(SEC);
  try {
    const v = U.validateSlug(req.body.slug);
    const page = v.ok ? (await pool.query('SELECT id FROM uzel_pages WHERE slug = $1', [v.slug])).rows[0] : null;
    if (page) {
      await pool.query('INSERT INTO uzel_reports (page_id, reason, details) VALUES ($1,$2,$3)', [page.id, U.cleanText(req.body.reason, 80) || 'Другое', U.cleanText(req.body.details, 500)]);
    }
    const s = U.simplePage('Спасибо', '<h1>Жалоба отправлена</h1><p>Мы проверим страницу и примем меры, если правила нарушены.</p>');
    res.type('html').send(s.html);
  } catch (err) {
    res.status(500).type('text').send('Ошибка сервера');
  }
});


/* ---------- предпросмотр (сохранённая версия, клики не считаются) ---------- */
router.get('/me/preview', needUser, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    res.set(Object.assign({}, SEC, { 'Content-Security-Policy': SEC['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'"), 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN' }));
    if (!rows[0]) {
      const s = U.simplePage('Предпросмотр', '<h1>Страница ещё не создана</h1><p>Заполните профиль и сохраните его, тогда здесь появится предпросмотр.</p>');
      return res.type('html').send(s.html);
    }
    res.type('html').send(U.renderPublicPage(rows[0], ORIGIN, { preview: true, plan: req.uz.user.plan }));
  } catch (err) {
    console.error('uzel/preview:', err);
    res.status(500).type('text').send('Ошибка сервера');
  }
});

/* ---------- заявки с формы ---------- */
router.post('/lead/:slug', limiter(60 * 60 * 1000, 8, 'Слишком много заявок с вашего адреса'), express.urlencoded({ extended: false, limit: '10kb' }), async (req, res) => {
  res.set(SEC);
  try {
    const v = U.validateSlug(req.params.slug);
    const { rows } = v.ok ? await pool.query('SELECT p.*, u.email AS owner_email FROM uzel_pages p JOIN uzel_users u ON u.id = p.user_id WHERE p.slug = $1 AND p.published AND NOT p.hidden', [v.slug]) : { rows: [] };
    const page = rows[0];
    const form = page && page.ext && page.ext.form;
    const en = page && page.ext && page.ext.lang === 'en';
    if (!page || !form || !form.enabled) return res.status(404).type('text').send('Not found');
    if (String(req.body.website || '').trim()) { // ловушка для ботов: делаем вид, что всё хорошо
      const s = U.simplePage(en ? 'Thanks' : 'Спасибо', `<h1>${en ? 'Sent' : 'Заявка отправлена'}</h1>`);
      return res.type('html').send(s.html);
    }
    const contact = U.cleanText(req.body.contact, 120);
    if (contact.length < 5) {
      const s = U.simplePage(en ? 'Check form' : 'Проверьте форму', `<h1>${en ? 'Add a phone or email' : 'Укажите телефон или почту'}</h1><p>${en ? 'So the owner can reply.' : 'Иначе владелец не сможет с вами связаться.'}</p><a class="b" href="javascript:history.back()">${en ? 'Back' : 'Назад'}</a>`, 400);
      return res.status(400).type('html').send(s.html);
    }
    const day = await pool.query("SELECT count(*)::int AS n FROM uzel_leads WHERE page_id = $1 AND created_at > now() - interval '1 day'", [page.id]);
    if (day.rows[0].n >= 40) {
      const s = U.simplePage(en ? 'Try later' : 'Попробуйте позже', `<h1>${en ? 'Too many requests today' : 'Сегодня заявок уже слишком много'}</h1>`, 429);
      return res.status(429).type('html').send(s.html);
    }
    const name = U.cleanText(req.body.name, 60), message = U.cleanText(req.body.message, 600);
    await pool.query('INSERT INTO uzel_leads (page_id, name, contact, message, ip) VALUES ($1,$2,$3,$4,$5)', [page.id, name, contact, message, cleanIp(req.ip)]);
    if (form.webhook) {
      const ownerPlan = await pool.query('SELECT plan, plan_until FROM uzel_users WHERE id = $1', [page.user_id]);
      if (U.planOf(ownerPlan.rows[0]) !== 'free') {
        sendWebhook(form.webhook, form.secret || '', { event: 'lead.created', page: { slug: page.slug, name: page.name, url: U.pageUrl(ORIGIN, page.slug) }, lead: { name, contact, message, created_at: new Date().toISOString() } })
          .then((code) => { if (code >= 400) console.error('uzel/webhook:', page.slug, 'HTTP', code); })
          .catch((e) => console.error('uzel/webhook:', page.slug, e.message));
      }
    }
    if (form.notify !== false) {
      try {
        const mail = mailer.uzelLeadEmail({ page: page.name, name, contact, message, link: `${ORIGIN}${U.BASE}/app/form` });
        transporter.sendMail({ from: process.env.MAIL_FROM, to: page.owner_email, subject: mail.subject, html: mail.html, text: mail.text, attachments: mail.attachments }).catch((e) => console.error('uzel/lead mail:', e.message));
      } catch (e) { console.error('uzel/lead mail:', e.message); }
    }
    const s = U.simplePage(en ? 'Thanks' : 'Спасибо', `<h1>${en ? 'Request sent' : 'Заявка отправлена'}</h1><p>${en ? 'The owner will get back to you soon.' : 'Владелец страницы скоро свяжется с вами.'}</p><a class="b" href="${U.pageUrl(ORIGIN, page.slug)}">${en ? 'Back to the page' : 'Вернуться на страницу'}</a>`);
    res.type('html').send(s.html);
  } catch (err) {
    console.error('uzel/lead:', err);
    res.status(500).type('text').send('Ошибка сервера');
  }
});

router.get('/me/leads', needUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.contact, l.message, l.is_read, l.created_at FROM uzel_leads l JOIN uzel_pages p ON p.id = l.page_id
        WHERE p.user_id = $1 ORDER BY l.created_at DESC LIMIT 300`, [req.uz.user.id]);
    res.json({ leads: rows.map((r) => ({ id: Number(r.id), name: r.name, contact: r.contact, message: r.message, read: r.is_read, created_at: r.created_at })), unread: rows.filter((r) => !r.is_read).length });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось загрузить заявки' });
  }
});
router.post('/me/leads/read-all', needUser, async (req, res) => {
  await pool.query('UPDATE uzel_leads SET is_read = true WHERE page_id IN (SELECT id FROM uzel_pages WHERE user_id = $1)', [req.uz.user.id]);
  res.json({ ok: true });
});
router.post('/me/leads/:id/read', needUser, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  await pool.query('UPDATE uzel_leads SET is_read = $3 WHERE id = $1 AND page_id IN (SELECT id FROM uzel_pages WHERE user_id = $2)', [id, req.uz.user.id, !(req.body && req.body.read === false)]);
  res.json({ ok: true });
});
router.delete('/me/leads/:id', needUser, async (req, res) => {
  const id = parseInt(req.params.id, 10) || 0;
  await pool.query('DELETE FROM uzel_leads WHERE id = $1 AND page_id IN (SELECT id FROM uzel_pages WHERE user_id = $2)', [id, req.uz.user.id]);
  res.json({ ok: true });
});
router.get('/me/leads.csv', needUser, async (req, res) => {
  if (req.uz.user.plan === 'free') return res.status(402).json({ error: 'Выгрузка заявок доступна в Pro' });
  const { rows } = await pool.query(
    `SELECT l.created_at, l.name, l.contact, l.message FROM uzel_leads l JOIN uzel_pages p ON p.id = l.page_id WHERE p.user_id = $1 ORDER BY l.created_at DESC`, [req.uz.user.id]);
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"';
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="uzel-leads.csv"' });
  res.send('\ufeff' + 'Дата;Имя;Контакт;Сообщение\n' + rows.map((r) => [new Date(r.created_at).toISOString(), r.name, r.contact, r.message].map(q).join(';')).join('\n'));
});

/* ---------- тариф и оплата (ЮKassa) ---------- */
async function ykRequest(method, path, body, idem) {
  const r = await fetch(YK_API + path, { method, headers: Object.assign({ Authorization: ykAuth(), 'Content-Type': 'application/json' }, idem ? { 'Idempotence-Key': idem } : {}), body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`ЮKassa ${r.status}: ${j.description || j.code || ''}`);
  return j;
}

async function creditPayment(paymentId) {
  const pay = await ykRequest('GET', `/payments/${encodeURIComponent(paymentId)}`);
  if (pay.status !== 'succeeded' || !pay.paid) return { credited: false, status: pay.status };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT * FROM uzel_payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const rec = row.rows[0];
    if (!rec) { await client.query('ROLLBACK'); return { credited: false, status: 'unknown' }; }
    if (rec.status === 'succeeded') { await client.query('ROLLBACK'); return { credited: false, status: 'already' }; }
    const plan = U.PLAN_PRICES[rec.plan_code];
    if (!plan || Number(pay.amount && pay.amount.value) !== Number(plan.amount)) { await client.query('ROLLBACK'); return { credited: false, status: 'amount' }; }
    await client.query("UPDATE uzel_payments SET status = 'succeeded', paid_at = now() WHERE id = $1", [paymentId]);
    await client.query(
      `UPDATE uzel_users SET plan = $3,
         plan_until = GREATEST(COALESCE(plan_until, now()), now()) + ($2::int * interval '1 day') WHERE id = $1`, [rec.user_id, plan.days, plan.tier]);
    await client.query('COMMIT');
    return { credited: true, status: 'succeeded' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

router.post('/me/plan/checkout', needUser, limiter(60 * 60 * 1000, 20), async (req, res) => {
  try {
    const code = String((req.body && req.body.plan) || '');
    const plan = U.PLAN_PRICES[code];
    if (!plan) return res.status(400).json({ error: 'Неизвестный тариф' });
    if (!ykOn()) return res.status(503).json({ error: 'Оплата подключается. Напишите на support@antviz.ru, включим Pro вручную.' });
    const body = {
      amount: { value: plan.amount, currency: 'RUB' }, capture: true, description: plan.title,
      confirmation: { type: 'redirect', return_url: `${ORIGIN}${U.BASE}/app/plan?paid=1` },
      metadata: { uzel_user: String(req.uz.user.id), plan: code },
    };
    const receipt = buildReceipt(req.uz.user.email, plan.title, plan.amount);
    if (receipt) body.receipt = receipt;
    const pay = await ykRequest('POST', '/payments', body, crypto.randomUUID());
    await pool.query('INSERT INTO uzel_payments (id, user_id, plan_code, amount) VALUES ($1,$2,$3,$4)', [pay.id, req.uz.user.id, code, plan.amount]);
    res.json({ ok: true, url: pay.confirmation && pay.confirmation.confirmation_url });
  } catch (err) {
    console.error('uzel/checkout:', err.message);
    res.status(502).json({ error: 'Не удалось создать платёж. Попробуйте позже.' });
  }
});

// Вызывается, когда человек вернулся после оплаты: проверяем платежи у ЮKassa сами, не дожидаясь уведомления
router.post('/me/plan/check', needUser, limiter(60 * 1000, 20), async (req, res) => {
  try {
    if (!ykOn()) return res.json({ ok: true, pending: 0 });
    const { rows } = await pool.query("SELECT id FROM uzel_payments WHERE user_id = $1 AND status = 'pending' AND created_at > now() - interval '2 days'", [req.uz.user.id]);
    let credited = 0;
    for (const r of rows) { const x = await creditPayment(r.id); if (x.credited) credited++; }
    res.json({ ok: true, credited, pending: rows.length - credited });
  } catch (err) {
    console.error('uzel/plan/check:', err.message);
    res.status(502).json({ error: 'Не удалось проверить оплату' });
  }
});

// Уведомление от ЮKassa: телу не верим, статус платежа перепроверяем запросом к API
router.post('/pay/webhook', async (req, res) => {
  try {
    const id = req.body && req.body.object && req.body.object.id;
    if (req.body && req.body.event === 'payment.succeeded' && typeof id === 'string' && /^[\w-]{10,60}$/.test(id) && ykOn()) await creditPayment(id);
    res.json({ ok: true });
  } catch (err) {
    console.error('uzel/pay/webhook:', err.message);
    res.status(500).json({ ok: false });
  }
});


router.post('/me/webhook/test', needUser, limiter(60 * 1000, 6, 'Слишком часто. Подождите минуту'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT slug, name, ext FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    const page = rows[0], form = page && page.ext && page.ext.form;
    if (!form || !form.webhook) return res.status(400).json({ error: 'Сначала сохраните адрес вебхука' });
    if (req.uz.user.plan === 'free') return res.status(402).json({ error: 'Вебхук доступен в Pro' });
    const code = await sendWebhook(form.webhook, form.secret || '', { event: 'test', page: { slug: page.slug, name: page.name, url: U.pageUrl(ORIGIN, page.slug) }, lead: { name: 'Тест', contact: 'test@example.com', message: 'Проверка вебхука', created_at: new Date().toISOString() } });
    res.json({ ok: code < 400, status: code });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Не удалось отправить' });
  }
});
router.get('/me/webhook', needUser, async (req, res) => {
  const { rows } = await pool.query('SELECT ext FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
  const f = rows[0] && rows[0].ext && rows[0].ext.form;
  res.json({ secret: f ? f.secret || '' : '' });
});

router.put('/me/settings', needUser, async (req, res) => {
  try {
    const digest = !!(req.body && req.body.digest);
    await pool.query('UPDATE uzel_users SET digest = $2 WHERE id = $1', [req.uz.user.id, digest]);
    res.json({ ok: true, digest });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось сохранить' });
  }
});

module.exports = router;
