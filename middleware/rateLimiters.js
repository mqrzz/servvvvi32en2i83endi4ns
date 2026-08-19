const rateLimit = require('express-rate-limit');

// Не больше 5 запросов кода на email/IP за 15 минут — защита от спама письмами
const sendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Слишком много запросов кода. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.body?.email || ''}`,
});

// Не больше 10 попыток ввода кода за 15 минут с одного IP — защита от подбора
const verifyCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Слишком много попыток. Попробуйте позже.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { sendCodeLimiter, verifyCodeLimiter };
