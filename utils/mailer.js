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

// ── Лого Antviz (белый вариант, для тёмной плашки) ──
const LOGO_SVG = `<svg viewBox="0 0 1692 484" xmlns="http://www.w3.org/2000/svg" fill="none" style="height:52px; width:auto; display:block; margin:0 auto;"><g transform="translate(0,484) scale(0.1,-0.1)" fill="#ffffff"><path d="M13107 4247 c-49 -14 -128 -91 -161 -155 -54 -106 -25 -237 70 -321 92 -81 177 -99 275 -60 164 64 227 226 151 391 -16 35 -40 73 -53 85 -62 56 -197 85 -282 60z"/><path d="M7857 3914 c-4 -4 -7 -505 -7 -1113 0 -1051 1 -1111 19 -1196 20 -93 63 -209 99 -267 11 -18 34 -55 51 -83 112 -186 306 -327 536 -391 l100 -28 444 -4 c277 -2 447 0 453 6 14 14 12 411 -3 428 -9 11 -76 14 -361 14 -322 0 -356 2 -439 21 -154 37 -281 131 -344 254 -77 152 -78 161 -82 788 -3 419 -1 562 8 573 9 12 81 14 430 14 247 0 428 4 443 10 l26 10 0 213 c0 152 -3 216 -12 225 -9 9 -121 12 -444 12 -335 0 -435 3 -441 13 -4 6 -10 122 -13 257 l-5 245 -226 3 c-124 1 -228 -1 -232 -4z"/><path d="M2090 3388 c-19 -5 -63 -15 -97 -22 -34 -7 -119 -42 -190 -76 -115 -57 -137 -73 -223 -156 -90 -88 -105 -109 -164 -234 -11 -25 -27 -52 -33 -61 -7 -8 -20 -38 -29 -65 -54 -169 -64 -279 -64 -696 0 -277 4 -379 15 -450 15 -85 60 -232 85 -275 5 -10 15 -29 20 -43 17 -40 58 -104 105 -164 44 -56 195 -172 283 -217 84 -43 175 -73 266 -89 65 -11 1114 -12 1276 -1 90 6 95 7 98 30 2 13 -6 36 -17 52 -12 15 -21 31 -21 35 0 4 -15 30 -34 58 -18 28 -57 96 -85 151 -29 55 -58 103 -64 107 -7 4 -226 8 -487 8 -439 0 -481 2 -548 20 -168 44 -316 187 -347 332 -4 18 -11 38 -15 43 -17 23 -21 105 -21 443 1 330 3 363 22 432 24 85 39 121 73 168 69 94 122 135 231 179 l70 28 680 0 680 0 5 -1045 c3 -575 6 -1046 8 -1047 1 -2 105 -3 231 -3 195 0 232 2 245 16 14 14 16 143 16 1273 0 964 -3 1260 -12 1269 -15 15 -1903 15 -1958 0z"/><path d="M5310 3390 c-132 -28 -199 -55 -328 -133 -84 -51 -163 -129 -245 -243 -74 -103 -121 -256 -143 -469 -21 -193 -17 -1681 4 -1702 19 -19 445 -19 460 0 8 9 12 275 15 847 3 763 5 840 21 895 35 119 130 236 230 285 124 61 137 62 679 58 l492 -4 63 -28 c124 -54 198 -122 258 -239 47 -89 47 -94 51 -971 2 -582 7 -834 14 -843 16 -18 449 -19 467 -1 9 9 12 208 12 833 0 857 2 815 -40 1021 -28 134 -93 272 -181 383 -80 99 -162 166 -269 217 -41 20 -84 41 -95 47 -11 6 -36 14 -55 18 -19 3 -62 14 -95 23 -52 14 -136 16 -670 15 -335 -1 -626 -5 -645 -9z"/><path d="M9603 3385 c-6 -18 15 -68 106 -245 133 -260 538 -1068 567 -1130 16 -36 61 -126 98 -200 38 -74 77 -153 87 -175 10 -22 60 -128 112 -235 53 -107 127 -262 166 -345 39 -82 79 -166 88 -185 l18 -35 229 -3 c198 -2 231 0 247 14 17 15 67 112 184 359 31 66 61 127 66 135 5 8 18 33 28 55 10 22 42 90 70 150 28 61 56 119 63 130 27 46 148 294 148 303 0 5 25 56 55 113 31 57 69 133 86 169 27 58 140 289 272 555 25 50 68 135 96 190 134 264 181 369 170 382 -9 10 -67 13 -263 13 -138 0 -256 -4 -262 -8 -18 -12 -194 -360 -194 -384 0 -7 -13 -38 -29 -68 -91 -177 -127 -252 -191 -391 -40 -84 -96 -210 -127 -279 -30 -69 -58 -133 -63 -142 -39 -71 -149 -298 -155 -318 -9 -32 -122 -264 -152 -312 -13 -21 -30 -38 -37 -38 -13 0 -124 214 -216 415 -17 39 -71 151 -120 250 -193 395 -241 495 -298 620 -33 72 -71 150 -86 175 -14 25 -30 55 -35 67 -6 12 -33 70 -62 130 -28 59 -69 145 -90 189 -21 45 -46 85 -55 88 -8 3 -128 6 -265 6 -215 0 -250 -2 -256 -15z"/><path d="M12966 3384 c-14 -14 -16 -142 -16 -1265 0 -843 3 -1257 10 -1270 10 -18 23 -19 233 -19 160 0 226 3 235 12 9 9 12 306 12 1275 0 1238 0 1262 -19 1273 -12 6 -104 10 -230 10 -177 0 -212 -2 -225 -16z"/><path d="M14043 3393 c-16 -6 -18 -419 -3 -443 8 -13 101 -16 702 -20 671 -5 693 -6 696 -24 2 -10 -3 -23 -11 -27 -8 -5 -41 -41 -73 -81 -33 -40 -111 -136 -174 -213 -133 -161 -205 -251 -308 -379 -41 -50 -90 -109 -110 -131 -21 -22 -64 -74 -97 -116 -111 -142 -189 -240 -295 -366 -58 -69 -129 -157 -158 -195 -29 -38 -82 -106 -117 -151 -35 -45 -82 -105 -105 -134 l-40 -52 0 -109 c0 -91 3 -111 16 -116 9 -3 536 -6 1173 -6 887 0 1160 3 1169 12 17 17 17 409 0 426 -9 9 -199 12 -795 12 -657 0 -783 2 -783 14 0 7 24 41 53 74 146 169 252 295 309 369 110 142 220 276 269 328 26 28 67 75 91 106 57 75 272 330 337 399 28 30 51 58 51 61 0 10 257 321 322 390 13 14 52 59 85 100 l61 75 0 87 c1 65 -3 90 -14 102 -14 13 -141 15 -1127 14 -612 0 -1118 -3 -1124 -6z"/></g></svg>`;

// ── Соцсети Antviz (иконки + ссылки, везде @antviz_official) ──
const SOCIAL_LINKS = [
  {
    url: 'https://t.me/antviz_official',
    icon: '<path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8.287 5.906q-1.168.486-4.666 2.01-.567.225-.595.442c-.03.243.275.339.69.47l.175.055c.408.133.958.288 1.243.294q.39.01.868-.32 3.269-2.206 3.374-2.23c.05-.012.12-.026.166.016s.042.12.037.141c-.03.129-1.227 1.241-1.846 1.817-.193.18-.33.307-.358.336a8 8 0 0 1-.188.186c-.38.366-.664.64.015 1.088.327.216.589.393.85.571.284.194.568.387.936.629q.14.092.27.187c.331.236.63.448.997.414.214-.02.435-.22.547-.82.265-1.417.786-4.486.906-5.751a1.4 1.4 0 0 0-.013-.315.34.34 0 0 0-.114-.217.53.53 0 0 0-.31-.093c-.3.005-.763.166-2.984 1.09"/>',
  },
  {
    url: 'https://instagram.com/antviz_official',
    icon: '<path d="M8 0C5.829 0 5.556.01 4.703.048 3.85.088 3.269.222 2.76.42a3.9 3.9 0 0 0-1.417.923A3.9 3.9 0 0 0 .42 2.76C.222 3.268.087 3.85.048 4.7.01 5.555 0 5.827 0 8.001c0 2.172.01 2.444.048 3.297.04.852.174 1.433.372 1.942.205.526.478.972.923 1.417.444.445.89.719 1.416.923.51.198 1.09.333 1.942.372C5.555 15.99 5.827 16 8 16s2.444-.01 3.298-.048c.851-.04 1.434-.174 1.943-.372a3.9 3.9 0 0 0 1.416-.923c.445-.445.718-.891.923-1.417.197-.509.332-1.09.372-1.942C15.99 10.445 16 10.173 16 8s-.01-2.445-.048-3.299c-.04-.851-.175-1.433-.372-1.941a3.9 3.9 0 0 0-.923-1.417A3.9 3.9 0 0 0 13.24.42c-.51-.198-1.092-.333-1.943-.372C10.443.01 10.172 0 7.998 0zm-.717 1.442h.718c2.136 0 2.389.007 3.232.046.78.035 1.204.166 1.486.275.373.145.64.319.92.599s.453.546.598.92c.11.281.24.705.275 1.485.039.843.047 1.096.047 3.231s-.008 2.389-.047 3.232c-.035.78-.166 1.203-.275 1.485a2.5 2.5 0 0 1-.599.919c-.28.28-.546.453-.92.598-.28.11-.704.24-1.485.276-.843.038-1.096.047-3.232.047s-2.39-.009-3.233-.047c-.78-.036-1.203-.166-1.485-.276a2.5 2.5 0 0 1-.92-.598 2.5 2.5 0 0 1-.6-.92c-.109-.281-.24-.705-.275-1.485-.038-.843-.046-1.096-.046-3.233s.008-2.388.046-3.231c.036-.78.166-1.204.276-1.486.145-.373.319-.64.599-.92s.546-.453.92-.598c.282-.11.705-.24 1.485-.276.738-.034 1.024-.044 2.515-.045zm4.988 1.328a.96.96 0 1 0 0 1.92.96.96 0 0 0 0-1.92m-4.27 1.122a4.109 4.109 0 1 0 0 8.217 4.109 4.109 0 0 0 0-8.217m0 1.441a2.667 2.667 0 1 1 0 5.334 2.667 2.667 0 0 1 0-5.334"/>',
  },
  {
    url: 'https://tiktok.com/@antviz_official',
    icon: '<path d="M9 0h1.98c.144.715.54 1.617 1.235 2.512C12.895 3.389 13.797 4 15 4v2c-1.753 0-3.07-.814-4-1.829V11a5 5 0 1 1-5-5v2a3 3 0 1 0 3 3z"/>',
  },
  {
    url: 'https://threads.com/@antviz_official',
    icon: '<path d="M6.321 6.016c-.27-.18-1.166-.802-1.166-.802.756-1.081 1.753-1.502 3.132-1.502.975 0 1.803.327 2.394.948s.928 1.509 1.005 2.644q.492.207.905.484c1.109.745 1.719 1.86 1.719 3.137 0 2.716-2.226 5.075-6.256 5.075C4.594 16 1 13.987 1 7.994 1 2.034 4.482 0 8.044 0 9.69 0 13.55.243 15 5.036l-1.36.353C12.516 1.974 10.163 1.43 8.006 1.43c-3.565 0-5.582 2.171-5.582 6.79 0 4.143 2.254 6.343 5.63 6.343 2.777 0 4.847-1.443 4.847-3.556 0-1.438-1.208-2.127-1.27-2.127-.236 1.234-.868 3.31-3.644 3.31-1.618 0-3.013-1.118-3.013-2.582 0-2.09 1.984-2.847 3.55-2.847.586 0 1.294.04 1.663.114 0-.637-.54-1.728-1.9-1.728-1.25 0-1.566.405-1.967.868ZM8.716 8.19c-2.04 0-2.304.87-2.304 1.416 0 .878 1.043 1.168 1.6 1.168 1.02 0 2.067-.282 2.232-2.423a6.2 6.2 0 0 0-1.528-.161"/>',
  },
];

function socialRow() {
  const cells = SOCIAL_LINKS.map(
    ({ url, icon }) => `
        <td style="padding:0 5px;">
          <a href="${url}" target="_blank" style="width:48px; height:48px; border-radius:14px; background:#191b1e; display:flex; align-items:center; justify-content:center;">
            <svg width="24" height="24" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="#ffffff">${icon}</svg>
          </a>
        </td>`
  ).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr>${cells}</tr></table>`;
}

// ── Базовый каркас письма в фирменном стиле Antviz ──
function wrapEmail({ heading, bodyHtml, footerNote }) {
  return `
  <div style="background:#f2f2f4; padding:32px 16px; font-family:'Geologica',Arial,Helvetica,sans-serif;">
    <div style="max-width:480px; margin:0 auto;">

      <div style="background:#111214; border-radius:28px; padding:32px 28px; text-align:center;">
        ${LOGO_SVG}
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
