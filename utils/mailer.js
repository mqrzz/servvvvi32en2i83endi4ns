const nodemailer = require('nodemailer');
const path = require('path');

const useAuth = Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'localhost',
  port: Number(process.env.SMTP_PORT || 25),
  secure: Number(process.env.SMTP_PORT || 25) === 465,
  // Локальный Postfix использует самоподписанный сертификат — это ок,
  // соединение не покидает сервер (Node.js стучится в Postfix на этом же хосте).
  tls: { rejectUnauthorized: false },
  ...(useAuth
    ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
    : {}),
});

// ── Картинки письма ──
// Раньше лого и иконки соцсетей рисовались инлайновым <svg> — почтовые клиенты
// (Gmail, Outlook и т.д.) обрезают <svg> из HTML-писем, поэтому ничего не было видно.
// Теперь используем готовые PNG и вшиваем их прямо в письмо как cid-вложения
// (embedded images) — так почтовому клиенту не нужно ничего подгружать по сети,
// картинка "живёт" внутри самого письма. Файлы берутся с диска бэкенда,
// из папки img в корне репозитория (../img относительно этого файла в utils/).
const IMG_DIR = path.join(__dirname, '..', 'img');

const LOGO_FILE = 'logo-white.png'; // белый вариант лого, для тёмной плашки
const SOCIAL_LINKS = [
  { url: 'https://t.me/antviz_official', file: 'telegram-button.png' },
  { url: 'https://instagram.com/antviz_official', file: 'instagram-button.png' },
  { url: 'https://tiktok.com/@antviz_official', file: 'tiktok-button.png' },
  { url: 'https://threads.com/@antviz_official', file: 'threads-button.png' },
];

// Каждому файлу — уникальный cid, чтобы в html сослаться через src="cid:..."
function cidFor(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function imageAttachment(filename) {
  return {
    filename,
    path: path.join(IMG_DIR, filename),
    cid: cidFor(filename),
    // Без явного contentDisposition nodemailer по умолчанию ставит "attachment",
    // даже если задан cid — из-за этого Gmail показывает картинку как вложение.
    // "inline" убирает её из списка приложений, оставляя только встраивание в HTML.
    contentDisposition: 'inline',
  };
}

// Базовый набор вложений, нужных в любом письме (лого + соцсети)
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

// ── Базовый каркас письма в фирменном стиле Antviz ──
function wrapEmail({ heading, bodyHtml, footerNote }) {
  return `
  <div style="background:#f2f2f4; padding:32px 16px; font-family:'Geologica',Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto;">

      <div style="background:#111214; border-radius:28px; padding:32px 28px; text-align:center;">
        <img src="cid:${cidFor(LOGO_FILE)}" alt="Antviz" style="height:52px; width:auto; display:block; margin:0 auto;" />
      </div>

      <div style="background:#ffffff; border-radius:28px; padding:32px 28px; margin-top:16px;">
        <h1 style="margin:0 0 16px; font-size:22px; color:#111214; font-weight:700;">
          ${heading}
        </h1>
        <div style="font-size:15px; line-height:1.6; color:#3a3a3e;">
          ${bodyHtml}
        </div>
      </div>

      <div style="text-align:center; margin-top:20px;">
        ${socialRow()}
        <div style="margin-top:16px; font-size:13px; font-weight:600; color:#191b1e;">@antviz_official</div>
        <div style="margin-top:4px; font-size:12px; color:#9a9a9e;">Москва, Россия</div>
        <div style="margin-top:14px; font-size:12px; color:#9a9a9e; line-height:1.5;">
          ${footerNote || 'Antviz &middot; antviz.ru'}
        </div>
        <div style="margin-top:10px; font-size:10.5px; color:#b3b3b8; line-height:1.5; max-width:420px; margin-left:auto; margin-right:auto;">
          *Meta Platforms Inc. (включая Instagram и Threads) признана экстремистской организацией, её деятельность запрещена на территории РФ.
        </div>
      </div>

    </div>
  </div>`;
}

function codeBlock(code) {
  return `
    <div style="background:#f2f2f4; border-radius:20px; padding:18px 24px; text-align:center; margin:20px 0;">
      <span style="font-size:32px; font-weight:700; letter-spacing:8px; color:#111214;">${code}</span>
    </div>
    <p style="font-size:13px; color:#9a9a9e;">Код действителен 10 минут. Если это были не вы — просто проигнорируйте письмо.</p>`;
}

function button(text, url) {
  return `
    <a href="${url}" style="display:inline-block; background:#1ede7b; color:#111214; text-decoration:none; font-weight:700; padding:14px 28px; border-radius:24px; font-size:15px; margin-top:8px;">
      ${text}
    </a>`;
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

module.exports = {
  sendCodeEmail,
  sendNewDeviceLoginEmail,
  sendAccountDeletedEmail,
  sendNewOrderEmail,
  sendStatusSubscribedEmail,
  sendIncidentUpdateEmail,
  sendEnterpriseApplicationAdminEmail,
  sendEnterpriseApplicationConfirmationEmail,
};

// ── Статус-страница: подтверждение подписки ──
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

// ── Статус-страница: новое обновление по инциденту ──
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

// ── Заявка на крупный проект / свой сервер (enterprise.html) ──
// Кому слать уведомление о новой заявке — админский email. Если
// ADMIN_NOTIFY_EMAIL не задан в .env, письмо просто не отправляется
// (падать при этом не должно — см. .catch() в routes/enterprise.js).
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

// Подтверждение самому заявителю, что заявка принята
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
