// Публичные формы основного сайта Antviz: заявка с сайта и подписка на блог.
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const disposableDomains = require('disposable-email-domains');
const pool = require('../db/pool');
const { logConsent } = require('../utils/consent');
const { sendSiteRequestAdminEmail, sendBlogConfirmEmail } = require('../utils/mailer');

const router = express.Router();
const disposable = new Set(disposableDomains);
// совпадает с чипами на странице «Контакты»
const SERVICES = ['Хочу сайт', 'Нужно приложение', 'Нужен бот', 'Внедрить ИИ', 'Навести порядок в учёте', 'Нужен маркетинг'];
const ORIGIN = process.env.SITE_ORIGIN || 'https://antviz.ru';

const limiter = (windowMs, max, message) =>
  rateLimit({ windowMs, max, message: { error: message }, standardHeaders: true, legacyHeaders: false, skipFailedRequests: true });

const isEmail = (s) => typeof s === 'string' && s.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
const ipHash = (req) => crypto.createHash('sha256').update(String(req.ip || '') + (process.env.UZEL_PEPPER || 'antviz')).digest('hex').slice(0, 24);

// контакт: почта, телефон или Telegram
function validContact(c) {
  if (isEmail(c)) return true;
  if (/^@?[A-Za-z0-9_]{4,32}$/.test(c) || /^https?:\/\/t\.me\/[A-Za-z0-9_]{4,32}\/?$/.test(c)) return true;
  const digits = c.replace(/\D/g, '');
  return /^[+\d\s().-]{7,25}$/.test(c) && digits.length >= 7 && digits.length <= 15;
}

router.post('/request', limiter(10 * 60 * 1000, 4, 'Слишком много заявок. Попробуйте через несколько минут или напишите в Telegram.'), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // скрытое поле: молча делаем вид, что приняли
    if (Number(b.t) < 2500) return res.status(400).json({ error: 'Слишком быстро. Проверьте форму и отправьте ещё раз.' });
    const name = clean(b.name, 80), contact = clean(b.contact, 120), message = clean(b.message, 3000);
    if (name.length < 2) return res.status(400).json({ error: 'Укажите, как к вам обращаться' });
    if (!validContact(contact)) return res.status(400).json({ error: 'Оставьте почту, телефон или Telegram, чтобы мы могли ответить' });
    if (message.length < 10) return res.status(400).json({ error: 'Опишите задачу хотя бы в паре предложений' });
    if (b.consent !== true) return res.status(400).json({ error: 'Нужно согласие на обработку персональных данных' });
    const services = (Array.isArray(b.services) ? b.services : []).map((x) => clean(x, 30)).filter((x) => SERVICES.includes(x)).slice(0, 8);
    const page = /^\/[A-Za-z0-9\/_\-.]{0,100}$/.test(clean(b.page, 120)) ? clean(b.page, 120) : null;
    const { rows } = await pool.query(
      `INSERT INTO site_requests (name, contact, message, services, page, ip_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [name, contact, message, services, page, ipHash(req)]
    );
    logConsent(null, ['pd'], req, 'site_request', null, isEmail(contact) ? contact.toLowerCase() : null).catch(() => {});
    sendSiteRequestAdminEmail({ id: rows[0].id, name, contact, message, services, page }).catch((e) => console.error('site-request: письмо не отправлено:', e.message));
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/site/request:', err);
    res.status(500).json({ error: 'Не удалось отправить заявку. Напишите нам в Telegram.' });
  }
});

router.post('/blog-subscribe', limiter(10 * 60 * 1000, 4, 'Слишком много попыток. Попробуйте позже.'), async (req, res) => {
  try {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true, needsConfirmation: true });
    const email = clean(b.email, 120).toLowerCase();
    if (!isEmail(email)) return res.status(400).json({ error: 'Введите корректный email' });
    if (b.consent !== true) return res.status(400).json({ error: 'Нужно согласие на обработку персональных данных' });
    if (disposable.has(email.split('@')[1])) return res.status(400).json({ error: 'Временные адреса не поддерживаются, укажите постоянный' });
    const ex = await pool.query('SELECT id, confirmed_at, unsubscribe_token FROM blog_subscribers WHERE email = $1', [email]);
    if (ex.rows.length && ex.rows[0].confirmed_at) return res.json({ ok: true, alreadySubscribed: true });
    await pool.query(`DELETE FROM blog_subscribers WHERE confirmed_at IS NULL AND created_at < now() - interval '3 days'`);
    const confirm = crypto.randomBytes(24).toString('hex');
    let unsub;
    if (ex.rows.length) {
      unsub = ex.rows[0].unsubscribe_token;
      await pool.query('UPDATE blog_subscribers SET confirm_token = $1 WHERE id = $2', [confirm, ex.rows[0].id]);
    } else {
      unsub = crypto.randomBytes(24).toString('hex');
      await pool.query('INSERT INTO blog_subscribers (email, confirm_token, unsubscribe_token, source) VALUES ($1,$2,$3,$4)', [email, confirm, unsub, clean(b.page, 120) || null]);
    }
    logConsent(null, ['pd'], req, 'blog_subscribe', null, email).catch(() => {});
    await sendBlogConfirmEmail(email, `${ORIGIN}/api/site/blog-confirm/${confirm}`, `${ORIGIN}/api/site/blog-unsubscribe/${unsub}`);
    res.json({ ok: true, needsConfirmation: true });
  } catch (err) {
    console.error('POST /api/site/blog-subscribe:', err);
    res.status(500).json({ error: 'Не удалось оформить подписку' });
  }
});

const resultPage = (title, text) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} · Antviz</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f2f2f4;font:17px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0b0b0d">
<main style="max-width:460px;margin:20px;background:#fff;border-radius:28px;padding:36px;box-shadow:0 0 0 1px #0b0b0d1a"><h1 style="font-size:26px;letter-spacing:-.04em;margin:0 0 12px">${title}</h1><p style="margin:0 0 24px;color:#6e6a70">${text}</p>
<a href="${ORIGIN}/blog/" style="display:inline-block;background:#06f;color:#fff;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:16px">В блог</a></main></body></html>`;

router.get('/blog-confirm/:token', async (req, res) => {
  try {
    const t = String(req.params.token || '');
    const { rows } = /^[a-f0-9]{48}$/.test(t)
      ? await pool.query('UPDATE blog_subscribers SET confirmed_at = now(), confirm_token = NULL WHERE confirm_token = $1 AND confirmed_at IS NULL RETURNING id', [t])
      : { rows: [] };
    res.status(rows.length ? 200 : 404).type('html').send(rows.length ? resultPage('Подписка подтверждена', 'Будем присылать письмо, когда выходит новая статья. Отписаться можно по ссылке в любом письме.') : resultPage('Ссылка не работает', 'Подписка уже подтверждена или ссылка устарела. Можно оформить подписку заново на странице блога.'));
  } catch (err) {
    console.error('GET /api/site/blog-confirm:', err);
    res.status(500).type('html').send(resultPage('Ошибка', 'Не получилось подтвердить подписку. Попробуйте позже.'));
  }
});

router.get('/blog-unsubscribe/:token', async (req, res) => {
  try {
    const t = String(req.params.token || '');
    const { rows } = /^[a-f0-9]{48}$/.test(t)
      ? await pool.query('DELETE FROM blog_subscribers WHERE unsubscribe_token = $1 RETURNING id', [t])
      : { rows: [] };
    res.status(rows.length ? 200 : 404).type('html').send(rows.length ? resultPage('Вы отписались', 'Адрес удалён, писем больше не будет.') : resultPage('Ссылка не работает', 'Адрес уже удалён из рассылки.'));
  } catch (err) {
    console.error('GET /api/site/blog-unsubscribe:', err);
    res.status(500).type('html').send(resultPage('Ошибка', 'Не получилось отписать. Попробуйте позже.'));
  }
});

module.exports = router;
