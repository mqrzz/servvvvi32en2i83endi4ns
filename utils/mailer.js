const nodemailer = require('nodemailer');
const path = require('path');

const useAuth = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: Number(process.env.SMTP_PORT || 25),
  secure: Number(process.env.SMTP_PORT || 25) === 465,
  tls: { rejectUnauthorized: false },
  ...(useAuth
    ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
    : {}),
});

// Для тестов: письма не уходят в SMTP, а дописываются в файл (по одной JSON-строке)
if (process.env.MAIL_CAPTURE_FILE) {
  transporter.sendMail = async (m) => {
    require('fs').appendFileSync(process.env.MAIL_CAPTURE_FILE, JSON.stringify({ to: m.to, subject: m.subject, html: m.html, headers: m.headers }) + '\n');
    return { messageId: 'captured' };
  };
}

const IMG_DIR = path.join(__dirname, '..', 'img');
const SENT_WITH_FILE = 'geserd-sent-with-light.gif';

const LOGO_FILE = 'logo-white.png';
const SOCIAL_LINKS = [
  { url: 'https://t.me/antviz_official', file: 'telegram-button.png' },
  { url: 'https://instagram.com/antviz_official', file: 'instagram-button.png' },
  { url: 'https://tiktok.com/@antviz_official', file: 'tiktok-button.png' },
  { url: 'https://threads.com/@antviz_official', file: 'threads-button.png' },
];

function cidFor(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function imageAttachment(filename) {
  return {
    filename,
    path: path.join(IMG_DIR, filename),
    cid: cidFor(filename),
    contentDisposition: 'inline',
  };
}

function baseAttachments() {
  return [imageAttachment(LOGO_FILE), ...SOCIAL_LINKS.map(({ file }) => imageAttachment(file))];
}

function socialRow() {
  const cells = SOCIAL_LINKS.map(
    ({ url, file }) => `
        <td style="padding:0 5px;">
          <a href="${url}" target="_blank" style="display:block; width:48px; height:48px;">
            <img src="cid:${cidFor(file)}" width="48" height="48" alt="" style="display:block; width:48px; height:48px; border-radius:14px;" />
          </a>
        </td>`
  ).join('');
  return `<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>${cells}</tr></table>`;
}

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = "-apple-system,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const DISPLAY = "'Arial Black','Segoe UI',Arial,sans-serif";

// Общий каркас всех писем: синяя шапка с логотипом и заголовком, белая карточка с содержимым, спокойный подвал
function emailLayout({ brand, heading, lead, bodyHtml, footerHtml, preheader, logoCid, brandName, art }) {
  const hero = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#0066ff" style="background:#0066ff;background-image:linear-gradient(150deg,#3d8bff 0%,#0066ff 55%,#0047c2 100%);border-radius:32px;">
    <tr><td style="padding:28px 30px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;"><img src="cid:${logoCid}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;"></td>
        <td style="vertical-align:middle;padding-left:10px;font-family:${DISPLAY};font-size:22px;font-weight:900;letter-spacing:-.5px;color:#ffffff;">${brandName}</td>
      </tr></table>
      <h1 style="margin:30px 0 0;font-family:${DISPLAY};font-size:36px;line-height:1.08;font-weight:900;letter-spacing:-1.4px;color:#ffffff;">${heading}</h1>
      ${lead ? `<p style="margin:14px 0 0;font-family:${FONT};font-size:17px;line-height:1.5;color:#dce9ff;">${lead}</p>` : ''}
    </td></tr>
    ${art ? `<tr><td style="padding:30px 30px 0;"><img src="cid:${art}" width="100%" alt="" style="display:block;width:100%;height:auto;border:0;"></td></tr>` : '<tr><td style="height:32px;line-height:32px;font-size:0;">&nbsp;</td></tr>'}
  </table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(String(heading).replace(/<[^>]+>/g, ''))}</title></head>
<body style="margin:0;padding:0;background:#eaf1ff;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eaf1ff;">${esc(preheader || '')}&#8199;&zwnj;&#8199;&zwnj;&#8199;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#eaf1ff" style="background:#eaf1ff;"><tr><td align="center" style="padding:28px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
    <tr><td>${hero}</td></tr>
    <tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>
    <tr><td style="background:#ffffff;border-radius:28px;padding:28px;font-family:${FONT};font-size:16px;line-height:1.55;color:#2b2b30;">${bodyHtml}</td></tr>
    <tr><td align="center" style="padding:22px 10px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:#7b8294;">${footerHtml}</td></tr>
    <tr><td align="center" style="padding:26px 0 4px;"><a href="https://geserd.com" target="_blank" style="text-decoration:none;"><img src="cid:${cidFor(SENT_WITH_FILE)}" width="180" height="66" alt="Sent with Geserd" style="display:block;border:0;width:180px;height:66px;margin:0 auto;"></a></td></tr>
  </table>
</td></tr></table></body></html>`;
}

function wrapEmail({ heading, bodyHtml, footerNote }) {
  return emailLayout({
    brandName: 'antviz', logoCid: cidFor(LOGO_FILE), art: 'antviz-art', heading, bodyHtml,
    footerHtml: `${socialRow()}<div style="margin-top:14px;font-size:13px;font-weight:600;color:#191b1e;">@antviz_official</div><div style="margin-top:4px;">Москва, Россия</div><div style="margin-top:12px;">${footerNote || 'Antviz &middot; antviz.ru'}</div><div style="margin-top:10px;font-size:10.5px;color:#9aa1b2;max-width:420px;">*Meta Platforms Inc. (включая Instagram и Threads) признана экстремистской организацией, её деятельность запрещена на территории РФ.</div>`,
  });
}

function digitsBlock(code) {
  const cells = String(code).split('').map((d) => `<td align="center" width="16%" style="padding:0 3px;"><div style="background:#f4f7ff;border:2px solid #d9e6ff;border-radius:18px;padding:18px 0;font-family:${DISPLAY};font-size:34px;font-weight:900;color:#0b0b0d;">${d}</div></td>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;"><tr>${cells}</tr></table>`;
}

function codeBlock(code) {
  return `${digitsBlock(code)}
    <p style="margin:16px 0 0;font-size:13px;color:#7b8294;">Код действителен 10 минут. Если это были не вы, просто проигнорируйте письмо.</p>`;
}

function button(text, url) {
  return `<a href="${url}" style="display:inline-block;background:#0066ff;color:#ffffff;text-decoration:none;font-weight:700;padding:15px 28px;border-radius:18px;font-size:16px;margin-top:8px;font-family:${FONT};">${text}</a>`;
}

/* ---------- письма «Узла» ---------- */
function uzelFooter(lang) {
  return lang === 'en'
    ? 'Uzel is a service by <a href="https://geserd.com" style="color:#5b6a8f;text-decoration:underline;">Geserd</a><br>You got this email because someone entered your address on Uzel.'
    : 'Узел — сервис <a href="https://geserd.com" style="color:#5b6a8f;text-decoration:underline;">Geserd</a><br>Вы получили письмо, потому что ваш адрес указали на сайте Узла.';
}

function uzelCodeEmail({ code, lang }) {
  const en = lang === 'en';
  const t = en
    ? { subject: `${code} is your Uzel code`, h: 'Your sign-in code', lead: 'Enter it on the Uzel page to continue.', note: 'The code works for 10 minutes. If this was not you, just ignore this email, nobody can sign in without the code.', pre: `Your code: ${code}` }
    : { subject: `${code} — код для входа в Узел`, h: 'Ваш код для входа', lead: 'Введите его на странице Узла, чтобы продолжить.', note: 'Код действует 10 минут. Если вы не запрашивали вход, просто проигнорируйте письмо: без кода войти нельзя.', pre: `Ваш код: ${code}` };
  const body = `${digitsBlock(code)}
    <p style="margin:18px 0 0;font-size:14px;line-height:1.55;color:#6b7284;">${t.note}</p>`;
  return {
    subject: t.subject,
    html: emailLayout({ brandName: 'узел', logoCid: 'uzel-mark', art: 'uzel-art', heading: t.h, lead: t.lead, bodyHtml: body, footerHtml: uzelFooter(lang).replace(/namespace/g, 'a8'), preheader: t.pre }),
    text: `${t.h}: ${code}\n\n${t.note}`,
    attachments: [imageAttachment('uzel-mark.png'), imageAttachment('uzel-art.png')],
  };
}

function uzelDigestEmail({ name, views, clicks, leads, top, link, lang }) {
  const en = lang === 'en';
  const nf = (n) => Number(n).toLocaleString(en ? 'en' : 'ru');
  const T = en
    ? { subject: 'Your Uzel week: ' + views + ' views', h: 'Your week on Uzel', lead: `Stats for the page «${esc(name)}» over the last 7 days.`, v: 'Views', c: 'Clicks', l: 'Requests', top: 'Most clicked', btn: 'Open stats', off: 'You can turn this email off in Security settings.' }
    : { subject: 'Ваша неделя в Узле: ' + views + ' просмотров', h: 'Ваша неделя в Узле', lead: `Статистика страницы «${esc(name)}» за последние 7 дней.`, v: 'Просмотры', c: 'Клики', l: 'Заявки', top: 'Чаще всего нажимали', btn: 'Открыть статистику', off: 'Это письмо можно отключить в разделе «Безопасность».' };
  const cell = (label, v) => `<td align="center" width="33%" style="padding:0 4px;"><div style="background:#f0f4ff;border-radius:18px;padding:16px 4px;"><div style="font-family:${DISPLAY};font-size:28px;font-weight:900;color:#0b0b0d;letter-spacing:-1px;">${nf(v)}</div><div style="font-size:13px;color:#6b7284;margin-top:4px;">${label}</div></div></td>`;
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cell(T.v, views)}${cell(T.c, clicks)}${cell(T.l, leads)}</tr></table>`
    + (top ? `<p style="margin:22px 0 0;font-size:13px;color:#7b8294;">${T.top}</p><p style="margin:4px 0 0;font-size:18px;font-weight:700;color:#0b0b0d;">${esc(top.title)} <span style="color:#6b7284;font-weight:500;font-size:15px;">· ${nf(top.clicks)}</span></p>` : '')
    + `<div style="margin-top:22px;">${button(T.btn, link)}</div><p style="margin:18px 0 0;font-size:13px;color:#7b8294;">${T.off}</p>`;
  return {
    subject: T.subject,
    html: emailLayout({ brandName: en ? 'uzel' : 'узел', logoCid: 'uzel-mark', art: 'uzel-art', heading: T.h, lead: T.lead, bodyHtml: body, footerHtml: uzelFooter(lang).replace(/namespace/g, 'a8'), preheader: `${nf(views)} / ${nf(clicks)} / ${nf(leads)}` }),
    text: `${T.h}\n${T.v}: ${views}\n${T.c}: ${clicks}\n${T.l}: ${leads}\n${link}`,
    attachments: [imageAttachment('uzel-mark.png'), imageAttachment('uzel-art.png')],
  };
}

function uzelLeadEmail({ page, name, contact, message, link }) {
  const row = (k, v) => v ? `<tr><td style="padding:10px 0;border-bottom:1px solid #eef1f8;font-size:13px;color:#7b8294;width:96px;vertical-align:top;">${k}</td><td style="padding:10px 0;border-bottom:1px solid #eef1f8;font-size:16px;font-weight:600;color:#0b0b0d;">${esc(v).replace(/\n/g, '<br>')}</td></tr>` : '';
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${row('Имя', name)}${row('Контакт', contact)}${row('Сообщение', message)}</table>
    <div style="margin-top:20px;">${button('Открыть заявки', link)}</div>`;
  return {
    subject: `Новая заявка на странице «${page}»`.slice(0, 150),
    html: emailLayout({ brandName: 'узел', logoCid: 'uzel-mark', art: 'uzel-art', heading: 'Новая заявка', lead: `Кто-то оставил заявку на вашей странице «${esc(page)}».`, bodyHtml: body, footerHtml: uzelFooter('ru').replace(/namespace/g, 'a8') + '<br>Уведомления можно отключить на вкладке «Заявки».', preheader: `${name || 'Посетитель'}: ${contact}` }),
    text: `Новая заявка на странице «${page}»\nИмя: ${name || '—'}\nКонтакт: ${contact}\n${message ? 'Сообщение: ' + message + '\n' : ''}\n${link}`,
    attachments: [imageAttachment('uzel-mark.png'), imageAttachment('uzel-art.png')],
  };
}

async function sendCodeEmail(toEmail, code, purpose, magicUrl) {
  const headings = {
    login: 'Код для входа',
    register: 'Подтверждение email',
    delete_account: 'Подтверждение удаления аккаунта',
    reset_password: 'Восстановление пароля',
  };
  const intros = {
    login: 'Кто-то (надеемся, что вы) пытается войти в аккаунт Antviz. Введите код ниже, чтобы продолжить:',
    register: 'Почти готово! Введите код ниже, чтобы подтвердить email и завершить регистрацию в Antviz:',
    delete_account: 'Вы запросили удаление аккаунта Antviz. Это действие необратимо. Если это точно вы — введите код ниже:',
    reset_password: 'Вы запросили восстановление пароля Antviz. Введите код ниже, чтобы задать новый пароль:',
  };

  const magicHtml = magicUrl ? `
    <div style="text-align:center; margin:18px 0 4px;">
      ${button('Войти одним кликом', magicUrl)}
      <p style="font-size:12px; color:#9a9a9e; margin-top:10px;">Ссылка одноразовая и работает только в этом браузере/устройстве, где вы запрашивали вход.</p>
    </div>` : '';

  const html = wrapEmail({
    heading: headings[purpose] || 'Код подтверждения',
    bodyHtml: `<p>${intros[purpose] || ''}</p>${codeBlock(code)}${magicHtml}`,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: headings[purpose] || 'Код подтверждения Antviz',
    html,
    attachments: baseAttachments(),
  });
}

async function sendNewDeviceLoginEmail(toEmail, { deviceName, ipAddress, time }) {
  const html = wrapEmail({
    heading: 'Новый вход в аккаунт',
    bodyHtml: `
      <p>Зафиксирован вход в ваш аккаунт Antviz с нового устройства:</p>
      <div style="background:#f2f2f4; border-radius:20px; padding:16px 20px; margin:16px 0; font-size:14px; color:#3a3a3e;">
        <div><b>Устройство:</b> ${deviceName || 'Неизвестно'}</div>
        <div><b>IP-адрес:</b> ${ipAddress || 'Неизвестно'}</div>
        <div><b>Время:</b> ${time}</div>
      </div>
      <p>Если это были не вы — зайдите в настройки аккаунта и завершите этот сеанс, либо смените вход.</p>
      ${button('Открыть аккаунт', 'https://antviz.ru/profile/settings')}
    `,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Новый вход в аккаунт Antviz',
    html,
    attachments: baseAttachments(),
  });
}

async function sendAccountDeletedEmail(toEmail) {
  const html = wrapEmail({
    heading: 'Аккаунт удалён',
    bodyHtml: `<p>Ваш аккаунт Antviz и связанные с ним личные данные были удалены. Если это была ошибка — свяжитесь с поддержкой в течение ближайшего времени.</p>`,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Аккаунт Antviz удалён',
    html,
    attachments: baseAttachments(),
  });
}

async function sendNewOrderEmail(toEmail, { orderId, packageName, totalPrice, paymentId }) {
  const html = wrapEmail({
    heading: 'Заказ принят в работу',
    bodyHtml: `
      <p>Мы получили ваш заказ и уже приступаем к работе.</p>
      <div style="background:#f2f2f4; border-radius:20px; padding:16px 20px; margin:16px 0; font-size:14px; color:#3a3a3e;">
        <div><b>Тариф:</b> ${packageName}</div>
        <div><b>Сумма:</b> ${totalPrice} ₽</div>
        ${paymentId ? `<div><b>Номер платежа:</b> ${paymentId}</div>` : ''}
      </div>
      ${button('Открыть заказ', `https://antviz.ru/profile/orders?id=${orderId}`)}
    `,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Ваш заказ принят — Antviz',
    html,
    attachments: baseAttachments(),
  });
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function sendNotificationEmail(toEmail, { title, text, buttonText, buttonUrl }) {
  const safeTitle = escHtml(title);
  const html = wrapEmail({
    heading: safeTitle,
    bodyHtml: `
      ${text ? `<p>${escHtml(text).replace(/\n/g, '<br/>')}</p>` : ''}
      ${buttonUrl ? `<div style="margin-top:8px;">${button(escHtml(buttonText || 'Открыть'), buttonUrl)}</div>` : ''}
    `,
    footerNote: 'Antviz &middot; antviz.ru<br/>Это письмо пришло, потому что вы включили e-mail-уведомления в настройках кабинета.',
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: String(title || 'Уведомление Antviz').slice(0, 150),
    html,
    attachments: baseAttachments(),
  });
}



async function sendSiteRequestAdminEmail({ id, name, contact, message, services, page }) {
  const to = process.env.ADMIN_NOTIFY_EMAIL || process.env.MAIL_FROM;
  if (!to) return;
  const row = (l, v) => `<tr><td style="padding:6px 14px 6px 0;color:#6e6a70;vertical-align:top;white-space:nowrap">${l}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`;
  const html = wrapEmail({
    heading: 'Новая заявка с сайта',
    bodyHtml: `<table style="border-collapse:collapse;font-size:15px">${row('Имя', escHtml(name))}${row('Контакт', escHtml(contact))}${services.length ? row('Что нужно', escHtml(services.join(', '))) : ''}${page ? row('Страница', escHtml(page)) : ''}</table>
      <p style="margin:16px 0 0;white-space:pre-wrap">${escHtml(message)}</p>${button('Открыть в админке', 'https://antviz.ru/admin/requests')}`,
    footerNote: `Заявка №${id} · antviz.ru`,
  });
  await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject: `Заявка с сайта: ${String(name).slice(0, 40)}`, html, attachments: baseAttachments() });
}

async function sendBlogConfirmEmail(toEmail, confirmUrl, unsubscribeUrl) {
  const html = wrapEmail({
    heading: 'Подтвердите подписку на блог',
    bodyHtml: `<p>Этот адрес указали для подписки на блог Antviz: письмо придёт, когда выйдет новая статья.</p>
      <p style="margin-top:12px;">Если это были не вы, просто проигнорируйте письмо: без подтверждения ничего не придёт, адрес удалится через 3 суток.</p>${button('Подтвердить подписку', confirmUrl)}`,
    footerNote: `Antviz &middot; antviz.ru<br/><a href="${unsubscribeUrl}" style="color:#9a9a9e;">Не подписывался(-ась), удалить адрес</a>`,
  });
  await transporter.sendMail({ from: process.env.MAIL_FROM, to: toEmail, subject: 'Подтвердите подписку на блог Antviz', html, attachments: baseAttachments() });
}

async function sendBlogPostEmail(toEmail, { title, excerpt, url, unsubscribeUrl }) {
  const html = wrapEmail({
    heading: title,
    bodyHtml: `${excerpt ? `<p>${escHtml(excerpt)}</p>` : ''}${button('Читать статью', url)}`,
    footerNote: `Antviz &middot; antviz.ru<br/><a href="${unsubscribeUrl}" style="color:#9a9a9e;">Отписаться от рассылки</a>`,
  });
  await transporter.sendMail({ from: process.env.MAIL_FROM, to: toEmail, subject: String(title).slice(0, 150), html, attachments: baseAttachments(),
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } });
}


// Плашка «Sent with Geserd» стоит в конце каждого письма: гарантируем, что картинка приложена, откуда бы письмо ни отправлялось
const _sendMail = transporter.sendMail.bind(transporter);
transporter.sendMail = (m, ...rest) => {
  if (m && typeof m.html === 'string') {
    const list = Array.isArray(m.attachments) ? m.attachments.slice() : [];
    const have = new Set(list.map((a) => a && a.cid));
    const files = require('fs').readdirSync(IMG_DIR);
    for (const mt of m.html.matchAll(/cid:([A-Za-z0-9_-]+)/g)) {
      if (have.has(mt[1])) continue;
      const f = files.find((n) => cidFor(n) === mt[1]);
      if (f) { list.push(imageAttachment(f)); have.add(mt[1]); }
    }
    m = Object.assign({}, m, { attachments: list });
  }
  return _sendMail(m, ...rest);
};

module.exports = {
  sendSiteRequestAdminEmail,
  sendBlogConfirmEmail,
  sendBlogPostEmail,
  transporter,
  wrapEmail,
  emailLayout,
  uzelCodeEmail,
  uzelLeadEmail,
  uzelDigestEmail,  imageAttachment,
  baseAttachments,
  sendCodeEmail,
  sendNewDeviceLoginEmail,
  sendAccountDeletedEmail,
  sendNewOrderEmail,
  sendNotificationEmail,
  sendStatusSubscribedEmail,
  sendStatusConfirmEmail,
  sendIncidentUpdateEmail,
  sendEnterpriseApplicationAdminEmail,
  sendEnterpriseApplicationConfirmationEmail,
};

async function sendStatusSubscribedEmail(toEmail, unsubscribeUrl) {
  const html = wrapEmail({
    heading: 'Подписка на статус Antviz',
    bodyHtml: `
      <p>Вы подписались на уведомления об изменении статуса сервисов Antviz и новых инцидентах.</p>
      <p style="margin-top:12px;">Письма будут приходить только когда что-то действительно меняется — без рассылок.</p>
      ${button('Смотреть статус', 'https://antviz.ru/status')}
    `,
    footerNote: `Antviz &middot; antviz.ru<br/><a href="${unsubscribeUrl}" style="color:#9a9a9e;">Отписаться от уведомлений о статусе</a>`,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Вы подписались на статус Antviz',
    html,
    attachments: baseAttachments(),
  });
}

async function sendStatusConfirmEmail(toEmail, confirmUrl, unsubscribeUrl) {
  const html = wrapEmail({
    heading: 'Подтвердите подписку на статус Antviz',
    bodyHtml: `
      <p>Кто-то (надеемся, вы) указал этот адрес для уведомлений об изменении статуса сервисов Antviz.</p>
      <p style="margin-top:12px;">Чтобы получать письма, подтвердите подписку. Если это были не вы, просто проигнорируйте письмо: без подтверждения вы ничего не получите, а адрес будет удалён через 3 суток.</p>
      ${button('Подтвердить подписку', confirmUrl)}
    `,
    footerNote: `Antviz &middot; antviz.ru<br/><a href="${unsubscribeUrl}" style="color:#9a9a9e;">Не подписывался(-ась), удалить адрес</a>`,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Подтвердите подписку на статус Antviz',
    html,
    attachments: baseAttachments(),
  });
}

const INCIDENT_STATUS_LABELS = {
  investigating: 'Расследуем',
  identified: 'Причина найдена',
  monitoring: 'Наблюдаем',
  resolved: 'Устранено',
};

async function sendIncidentUpdateEmail(toEmail, { incidentTitle, status, message, unsubscribeUrl }) {
  const label = INCIDENT_STATUS_LABELS[status] || status;
  const html = wrapEmail({
    heading: incidentTitle,
    bodyHtml: `
      <div style="display:inline-block; background:${status === 'resolved' ? '#e8fcf2' : '#fff4e5'}; color:${status === 'resolved' ? '#149955' : '#b45309'}; font-size:12px; font-weight:700; padding:4px 12px; border-radius:100px; text-transform:uppercase; letter-spacing:.03em; margin-bottom:14px;">${label}</div>
      <p>${message}</p>
      ${button('Смотреть статус', 'https://antviz.ru/status')}
    `,
    footerNote: `Antviz &middot; antviz.ru<br/><a href="${unsubscribeUrl}" style="color:#9a9a9e;">Отписаться от уведомлений о статусе</a>`,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: `[Antviz Status] ${incidentTitle} — ${label}`,
    html,
    attachments: baseAttachments(),
  });
}

async function sendEnterpriseApplicationAdminEmail(a) {
  if (!process.env.ADMIN_NOTIFY_EMAIL) {
    console.warn('ADMIN_NOTIFY_EMAIL не задан — письмо о новой enterprise-заявке не отправлено');
    return;
  }

  const rfLabel = { yes: 'Только серверы в РФ', no: 'РФ не нужна', no_matter: 'Неважно' }[a.servers_in_rf] || '—';

  const html = wrapEmail({
    heading: 'Новая заявка: крупный проект / свой сервер',
    bodyHtml: `
      <div style="background:#f2f2f4; border-radius:20px; padding:16px 20px; margin:16px 0; font-size:14px; color:#3a3a3e; text-align:left;">
        <div><b>Имя:</b> ${a.name}${a.company ? ` (${a.company})` : ''}</div>
        <div><b>Telegram:</b> ${a.telegram_username}</div>
        <div><b>Email:</b> ${a.email}</div>
        ${a.phone ? `<div><b>Телефон:</b> ${a.phone}</div>` : ''}
        <div style="margin-top:8px;"><b>Свой сервер:</b> ${a.own_server ? 'Да' : 'Нет'}</div>
        <div><b>Серверы в РФ:</b> ${rfLabel}</div>
        <div><b>Свои лимиты:</b> ${a.custom_limits ? 'Да' : 'Нет'}</div>
        ${a.expected_load ? `<div><b>Нагрузка:</b> ${a.expected_load}</div>` : ''}
        ${a.budget ? `<div><b>Бюджет:</b> ${a.budget}</div>` : ''}
        ${a.timeline ? `<div><b>Сроки:</b> ${a.timeline}</div>` : ''}
        <div style="margin-top:8px;"><b>Описание:</b><br/>${String(a.description || '').replace(/\n/g, '<br/>')}</div>
      </div>
      ${button('Открыть в админке', 'https://antviz.ru/admin/enterprise.html')}
    `,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `Новая заявка (крупный проект): ${a.name}`,
    html,
    attachments: baseAttachments(),
  });
}

async function sendEnterpriseApplicationConfirmationEmail(toEmail, name) {
  const html = wrapEmail({
    heading: 'Заявка получена',
    bodyHtml: `
      <p>${name ? name + ', в' : 'В'}аша заявка на крупный проект принята — мы её рассмотрим и напишем в Telegram или на почту в ближайшее время.</p>
      <p style="margin-top:10px;">Обычно отвечаем в течение рабочего дня.</p>
    `,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Заявка принята — Antviz',
    html,
    attachments: baseAttachments(),
  });
}
