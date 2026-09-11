const rateLimit = require('express-rate-limit');

// Не больше 5 запросов кода на email/IP за 1 час — защита от спама письмами
const sendCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Слишком много запросов кода. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body?.email || ''}`,
});

// Не больше 7 попыток ввода кода за 1 час с одного IP — защита от подбора
const verifyCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 7,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Не больше 1 заявки на "Крупные проекты" за 3 часа с одного IP — эндпоинт
// публичный, без авторизации и раньше был вообще без лимита: можно было
// заспамить и очередь в админке, и почту (каждая заявка триггерит письмо
// админу и письмо-подтверждение на указанный email — второе ещё и спамило
// бы чужой ящик, если email в заявке не свой).
const enterpriseLimiter = rateLimit({
  windowMs: 3 * 60 * 60 * 1000,
  max: 1,
  message: { error: 'Вы уже отправляли заявку недавно. Попробуйте позже или напишите в поддержку.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { sendCodeLimiter, verifyCodeLimiter, enterpriseLimiter };
