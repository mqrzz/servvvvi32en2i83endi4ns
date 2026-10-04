const rateLimit = require('express-rate-limit');

const sendCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Слишком много запросов кода. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body?.email || ''}`,
});

const verifyCodeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 7,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const enterpriseLimiter = rateLimit({
  windowMs: 3 * 60 * 60 * 1000,
  max: 1,
  message: { error: 'Вы уже отправляли заявку недавно. Попробуйте позже или напишите в поддержку.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { sendCodeLimiter, verifyCodeLimiter, enterpriseLimiter };
