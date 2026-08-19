const crypto = require('crypto');

// Генерирует 6-значный числовой код, например "042917"
function generateCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

// Хэшируем код перед сохранением в БД — так же, как с паролями:
// даже если БД утечёт, коды нельзя будет использовать напрямую.
function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function verifyCode(code, hash) {
  return hashCode(code) === hash;
}

module.exports = { generateCode, hashCode, verifyCode };
