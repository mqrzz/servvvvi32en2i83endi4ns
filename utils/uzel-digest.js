// Еженедельная сводка на почту (по понедельникам, только тем, кто включил, и только если за неделю что-то происходило)
const pool = require('../db/pool');
const mailer = require('./mailer');
const U = require('./uzel');
const ORIGIN = (process.env.UZEL_ORIGIN || 'https://antviz.ru').replace(/\/+$/, '');

async function runDigests() {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, p.id AS page_id, p.name, p.links, p.ext
       FROM uzel_users u JOIN uzel_pages p ON p.user_id = u.id
      WHERE u.digest AND NOT u.banned AND (u.digest_sent_at IS NULL OR u.digest_sent_at < now() - interval '6 days')`);
  let sent = 0;
  for (const r of rows) {
    try {
      const st = await pool.query(
        `SELECT count(*) FILTER (WHERE kind='view')::int AS views, count(*) FILTER (WHERE kind='click')::int AS clicks,
                (SELECT count(*) FROM uzel_leads WHERE page_id = $1 AND created_at > now() - interval '7 days')::int AS leads
           FROM uzel_events WHERE page_id = $1 AND ts > now() - interval '7 days'`, [r.page_id]);
      const s = st.rows[0];
      await pool.query('UPDATE uzel_users SET digest_sent_at = now() WHERE id = $1', [r.id]);
      if (!s.views && !s.clicks && !s.leads) continue;
      const topQ = await pool.query(`SELECT link_id AS id, count(*)::int AS n FROM uzel_events WHERE page_id = $1 AND kind='click' AND ts > now() - interval '7 days' GROUP BY link_id ORDER BY n DESC LIMIT 1`, [r.page_id]);
      let top = null;
      if (topQ.rows[0]) { const l = (r.links || []).find((x) => x.id === topQ.rows[0].id); if (l) top = { title: l.title, clicks: topQ.rows[0].n }; }
      const mail = mailer.uzelDigestEmail({ name: r.name, views: s.views, clicks: s.clicks, leads: s.leads, top, link: `${ORIGIN}${U.BASE}/app/stats`, lang: (r.ext && r.ext.lang) || 'ru' });
      await mailer.transporter.sendMail({ from: process.env.MAIL_FROM, to: r.email, subject: mail.subject, html: mail.html, text: mail.text, attachments: mail.attachments });
      sent++;
    } catch (e) { console.error('uzel/digest:', r.email, e.message); }
  }
  return sent;
}
function scheduleDigests() {
  const tick = () => { const d = new Date(Date.now() + 3 * 3600 * 1000); if (d.getUTCDay() === 1 && d.getUTCHours() >= 9) runDigests().catch((e) => console.error('uzel/digest:', e.message)); };
  setInterval(tick, 60 * 60 * 1000);
}
module.exports = { runDigests, scheduleDigests };
