const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendCodeEmail(toEmail, code, purpose) {
  const subjects = {
    login: 'Код для входа в Antviz',
    register: 'Код подтверждения регистрации Antviz',
    delete_account: 'Код подтверждения удаления аккаунта Antviz',
  };
  const subject = subjects[purpose] || 'Код подтверждения Antviz';

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
      <h2 style="color:#111;">Antviz</h2>
      <p style="font-size:16px; color:#333;">Ваш код подтверждения:</p>
      <div style="font-size:32px; font-weight:700; letter-spacing:8px; background:#f3f3f3; padding:16px 24px; border-radius:12px; text-align:center; color:#111;">
        ${code}
      </div>
      <p style="font-size:14px; color:#777; margin-top:16px;">Код действителен 10 минут. Если вы не запрашивали его — просто проигнорируйте это письмо.</p>
    </div>
  `;

  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: toEmail,
    subject,
    html,
  });
}

module.exports = { sendCodeEmail };
