const { TOTP, Secret } = require('otpauth');

function generateSecretBase32() {
  return new Secret({ size: 20 }).base32;
}

function buildTotp(secretBase32, email) {
  return new TOTP({
    issuer: 'Antviz',
    label: email || 'Antviz',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

function otpauthUrl(secretBase32, email) {
  return buildTotp(secretBase32, email).toString();
}

function verifyToken(secretBase32, token) {
  if (!secretBase32 || !token) return false;
  const totp = buildTotp(secretBase32, '');
  const delta = totp.validate({ token: String(token).trim(), window: 1 });
  return delta !== null;
}

module.exports = { generateSecretBase32, otpauthUrl, verifyToken };
