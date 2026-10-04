
const YANDEX_AUTH_URL = 'https://oauth.yandex.ru/authorize';
const YANDEX_TOKEN_URL = 'https://oauth.yandex.ru/token';
const YANDEX_INFO_URL = 'https://login.yandex.ru/info';

function getYandexAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.YANDEX_CLIENT_ID,
    redirect_uri: process.env.YANDEX_REDIRECT_URI,
    scope: 'login:email login:info',
    force_confirm: 'yes',
    state,
  });
  return `${YANDEX_AUTH_URL}?${params.toString()}`;
}

async function exchangeYandexCode(code) {
  const res = await fetch(YANDEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.YANDEX_CLIENT_ID,
      client_secret: process.env.YANDEX_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Не удалось обменять код Яндекса на токен: ${res.status} ${text}`);
  }
  return res.json();
}

async function fetchYandexUser(accessToken) {
  const res = await fetch(`${YANDEX_INFO_URL}?format=json`, {
    headers: { Authorization: `OAuth ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Не удалось получить данные пользователя Яндекса: ${res.status} ${text}`);
  }
  return res.json();
}

module.exports = { getYandexAuthUrl, exchangeYandexCode, fetchYandexUser };
