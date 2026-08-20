const nodemailer = require('nodemailer');

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

// ── Базовый каркас письма в фирменном стиле Antviz ──
function wrapEmail({ heading, bodyHtml, footerNote }) {
  return `
  <div style="background:#f2f2f4; padding:32px 16px; font-family:'Geologica',Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto;">

      <div style="background:#111214; border-radius:28px; padding:32px 28px; text-align:center;">
        <div style="color:#ffffff; font-size:20px; font-weight:700; letter-spacing:0.5px;">
          antviz
        </div>
      </div>

      <div style="background:#ffffff; border-radius:28px; padding:32px 28px; margin-top:16px;">
        <h1 style="margin:0 0 16px; font-size:22px; color:#111214; font-weight:700;">
          ${heading}
        </h1>
        <div style="font-size:15px; line-height:1.6; color:#3a3a3e;">
          ${bodyHtml}
        </div>
      </div>

      <div style="text-align:center; margin-top:20px; font-size:12px; color:#9a9a9e; line-height:1.5;">
        ${footerNote || 'Antviz &middot; antviz.ru'}
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

async function sendCodeEmail(toEmail, code, purpose) {
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

  const html = wrapEmail({
    heading: headings[purpose] || 'Код подтверждения',
    bodyHtml: `<p>${intros[purpose] || ''}</p>${codeBlock(code)}`,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: headings[purpose] || 'Код подтверждения Antviz',
    html,
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
      ${button('Открыть аккаунт', 'https://antviz.ru/profile/sessions')}
    `,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Новый вход в аккаунт Antviz',
    html,
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
  });
}

async function sendNewOrderEmail(toEmail, { orderId, packageName, totalPrice }) {
  const html = wrapEmail({
    heading: 'Заказ принят в работу',
    bodyHtml: `
      <p>Мы получили ваш заказ и уже приступаем к работе.</p>
      <div style="background:#f2f2f4; border-radius:20px; padding:16px 20px; margin:16px 0; font-size:14px; color:#3a3a3e;">
        <div><b>Тариф:</b> ${packageName}</div>
        <div><b>Сумма:</b> ${totalPrice} ₽</div>
      </div>
      ${button('Открыть заказ', `https://antviz.ru/profile/orders?id=${orderId}`)}
    `,
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject: 'Ваш заказ принят — Antviz',
    html,
  });
}

module.exports = {
  sendCodeEmail,
  sendNewDeviceLoginEmail,
  sendAccountDeletedEmail,
  sendNewOrderEmail,
};
