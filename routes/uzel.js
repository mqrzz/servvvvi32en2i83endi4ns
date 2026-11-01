const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');
const pool = require('../db/pool');
const U = require('../utils/uzel');
const { transporter, wrapEmail, baseAttachments } = require('../utils/mailer');
const { cleanIp, deviceClass } = require('../utils/analytics');

const router = express.Router();

const COOKIE = 'uzel_session';
const SESSION_DAYS = 30;
const PEPPER = process.env.UZEL_PEPPER || process.env.JWT_SECRET || 'uzel';
const ORIGIN = process.env.UZEL_ORIGIN || 'https://antviz.ru';
const DEV = process.env.UZEL_INSECURE_COOKIE === '1';
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
  if (req.path.startsWith('/report')) return next();
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
    `SELECT s.id AS sid, s.last_seen_at, u.id, u.email, u.name, u.banned
     FROM uzel_sessions s JOIN uzel_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha(token)]
  );
  if (!rows.length || rows[0].banned) return null;
  const r = rows[0];
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60 * 1000) {
    pool.query('UPDATE uzel_sessions SET last_seen_at = now() WHERE id = $1', [r.sid]).catch(() => {});
  }
  return { sid: Number(r.sid), user: { id: Number(r.id), email: r.email, name: r.name } };
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
      const html = wrapEmail({
        heading: 'Код для входа в Узел',
        bodyHtml: `<p>Ваш код:</p><div style="font:800 36px/1 Arial,sans-serif;letter-spacing:8px;background:#f2f2f4;border-radius:20px;padding:22px 0;text-align:center;margin:16px 0">${code}</div><p>Код действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо.</p>`,
      });
      await transporter.sendMail({ from: process.env.MAIL_FROM, to: email, subject: 'Код для входа в Узел', html, attachments: baseAttachments() });
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
  return p && { id: Number(p.id), slug: p.slug, name: p.name, subtitle: p.subtitle, bio: p.bio, avatar: p.avatar, theme: p.theme, socials: p.socials, links: p.links, music: p.music, published: p.published, hidden: p.hidden };
}

router.get('/me', needUser, async (req, res) => {
  try {
    const [p, s] = await Promise.all([
      pool.query('SELECT * FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]),
      pool.query('SELECT id, ua, ip, created_at, last_seen_at FROM uzel_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC', [req.uz.user.id]),
    ]);
    res.json({
      user: req.uz.user,
      page: pageOut(p.rows[0]),
      sessions: s.rows.map((r) => ({ id: Number(r.id), device: parseUa(r.ua), ip: maskIp(r.ip), created_at: r.created_at, last_seen_at: r.last_seen_at, current: Number(r.id) === req.uz.sid })),
      origin: ORIGIN,
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
    const v = U.validatePage(req.body || {}, existing);
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
          `UPDATE uzel_pages SET slug=$2, name=$3, subtitle=$4, bio=$5, theme=$6, socials=$7, links=$8, music=$9, published=$10, updated_at=now()
           WHERE user_id=$1 RETURNING *`,
          [req.uz.user.id, slug, d.name, d.subtitle, d.bio, d.theme, JSON.stringify(d.socials), JSON.stringify(d.links), d.music ? JSON.stringify(d.music) : null, d.published]
        );
      } else {
        row = await pool.query(
          `INSERT INTO uzel_pages (user_id, slug, name, subtitle, bio, theme, socials, links, music, published)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [req.uz.user.id, slug, d.name, d.subtitle, d.bio, d.theme, JSON.stringify(d.socials), JSON.stringify(d.links), d.music ? JSON.stringify(d.music) : null, d.published]
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
  const p = await pool.query('SELECT slug, name, subtitle, bio, theme, socials, links, music, published, created_at FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
  res.setHeader('Content-Disposition', 'attachment; filename="uzel-data.json"');
  res.json({ user: req.uz.user, page: p.rows[0] || null });
});

router.get('/me/stats', needUser, async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
    const p = await pool.query('SELECT id, links, socials, music FROM uzel_pages WHERE user_id = $1', [req.uz.user.id]);
    if (!p.rows.length) return res.json({ days, series: [], totals: { views: 0, clicks: 0 }, links: [], refs: [] });
    const page = p.rows[0], id = page.id;
    const since = `now() - ($2::int * interval '1 day')`;
    const [series, totals, links, refs] = await Promise.all([
      pool.query(
        `SELECT to_char(d::date,'YYYY-MM-DD') AS day, COALESCE(v.views,0)::int AS views, COALESCE(v.clicks,0)::int AS clicks
         FROM generate_series((now() AT TIME ZONE 'Europe/Moscow')::date - ($2::int - 1), (now() AT TIME ZONE 'Europe/Moscow')::date, interval '1 day') d
         LEFT JOIN (SELECT (ts AT TIME ZONE 'Europe/Moscow')::date AS day, count(*) FILTER (WHERE kind='view') AS views, count(*) FILTER (WHERE kind='click') AS clicks
                    FROM uzel_events WHERE page_id = $1 AND ts > ${since} GROUP BY 1) v ON v.day = d::date ORDER BY d`, [id, days]),
      pool.query(`SELECT count(*) FILTER (WHERE kind='view')::int AS views, count(*) FILTER (WHERE kind='click')::int AS clicks FROM uzel_events WHERE page_id = $1 AND ts > ${since}`, [id, days]),
      pool.query(`SELECT link_id, count(*)::int AS clicks FROM uzel_events WHERE page_id = $1 AND kind='click' AND ts > ${since} GROUP BY 1 ORDER BY clicks DESC`, [id, days]),
      pool.query(`SELECT COALESCE(ref,'Прямые заходы') AS ref, count(*)::int AS views FROM uzel_events WHERE page_id = $1 AND kind='view' AND ts > ${since} GROUP BY 1 ORDER BY views DESC LIMIT 8`, [id, days]),
    ]);
    const names = {};
    (page.links || []).forEach((l) => { names[l.id] = l.title; });
    (page.socials || []).forEach((s) => { names['s-' + s.type] = (U.SOCIALS[s.type] || {}).label || s.type; });
    if (page.music) names.music = 'Музыка: ' + page.music.title;
    res.json({ days, series: series.rows, totals: totals.rows[0], links: links.rows.map((r) => ({ title: names[r.link_id] || 'Удалённая ссылка', clicks: r.clicks })), refs: refs.rows });
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
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

router.get('/render/:slug', limiter(60 * 1000, 120), async (req, res) => {
  res.set(SEC);
  try {
    const v = U.validateSlug(req.params.slug);
    const { rows } = v.ok ? await pool.query('SELECT * FROM uzel_pages WHERE slug = $1', [v.slug]) : { rows: [] };
    const page = rows[0];
    if (!page || !page.published || page.hidden) {
      const s = U.simplePage('Страница не найдена', `<h1>Здесь пока пусто</h1><p>${page && page.hidden ? 'Страница недоступна.' : 'Такой страницы нет. Возможно, адрес свободен.'}</p><a class="b" href="${ORIGIN}/app/">Создать свою страницу</a>`, 404);
      return res.status(s.status).type('html').send(s.html);
    }
    const dev = deviceClass(req.get('user-agent'));
    if (dev !== 'bot' && req.get('dnt') !== '1') {
      pool.query('INSERT INTO uzel_events (page_id, kind, ref, device) VALUES ($1,$2,$3,$4)', [page.id, 'view', refHost(req.get('referer')), dev]).catch(() => {});
    }
    res.set('Cache-Control', 'no-store').type('html').send(U.renderPublicPage(page, ORIGIN));
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
      if (id === 'music') url = page.music && page.music.url;
      else if (id.startsWith('s-')) { const s = (page.socials || []).find((x) => 's-' + x.type === id); url = s && s.url; }
      else { const l = (page.links || []).find((x) => x.id === id && x.enabled !== false); url = l && l.url; }
    }
    if (!url || !U.normalizeUrl(url)) return res.status(404).type('text').send('Ссылка не найдена');
    const dev = deviceClass(req.get('user-agent'));
    if (dev !== 'bot') pool.query('INSERT INTO uzel_events (page_id, kind, link_id, device) VALUES ($1,$2,$3,$4)', [page.id, 'click', id.slice(0, 20), dev]).catch(() => {});
    res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' }).redirect(302, url);
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

module.exports = router;
