const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const RP_NAME = 'Antviz';
const RP_ID = process.env.WEBAUTHN_RP_ID || 'antviz.ru';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || 'https://antviz.ru';

module.exports = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  RP_NAME,
  RP_ID,
  ORIGIN,
};
