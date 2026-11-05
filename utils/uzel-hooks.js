// Отправка вебхука о новой заявке. Адрес задаёт пользователь, поэтому защищаемся от SSRF:
// только https на 443, адрес разрешается в IP заранее, внутренние диапазоны запрещены, соединение идёт именно на проверенный IP, редиректы не выполняются.
const dns = require('dns').promises;
const https = require('https');
const net = require('net');
const crypto = require('crypto');

function isPrivateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  const l = ip.toLowerCase();
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('::ffff:')) { const t = l.slice(7); return net.isIPv4(t) ? isPrivateV4(t) : true; }
  return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b') || l.startsWith('2001:db8');
}

async function sendWebhook(url, secret, payload) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.port || u.username) throw new Error('Адрес вебхука не подходит');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname, family: net.isIP(u.hostname) }] : await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Адрес вебхука ведёт во внутреннюю сеть');
  const pin = addrs[0];
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 5000, servername: u.hostname,
      lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: pin.address, family: pin.family }]) : cb(null, pin.address, pin.family)),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'UzelWebhook/1', 'X-Uzel-Event': payload.event, 'X-Uzel-Signature': 'sha256=' + sig },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('Адрес не ответил за 5 секунд')));
    req.on('error', reject);
    req.end(body);
  });
}
module.exports = { sendWebhook, isPrivateIp };
