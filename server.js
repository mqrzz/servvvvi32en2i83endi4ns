require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { requireAdmin } = require('./middleware/requireAuth');

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (процесс НЕ упал, только залогировано):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (процесс НЕ упал, только залогировано):', err);
});

const authRoutes = require('./routes/auth');
const sessionsRoutes = require('./routes/sessions');
const ordersRoutes = require('./routes/orders');
const notificationsRoutes = require('./routes/notifications');
const ticketsRoutes = require('./routes/tickets');
const serviceTicketsRoutes = require('./routes/service-tickets');
const promoCodesRoutes = require('./routes/promo-codes');
const bansRoutes = require('./routes/bans');
const reviewsRoutes = require('./routes/reviews');
const usersRoutes = require('./routes/users');
const paymentsRoutes = require('./routes/payments');
const botRoutes = require('./routes/bot');
const statusRoutes = require('./routes/status');
const enterpriseRoutes = require('./routes/enterprise');
const systemRoutes = require('./routes/system');
const blogCmsRoutes = require('./routes/blog-cms');
const { checkExpiringSubscriptions } = require('./utils/subscriptionReminders');
const { cleanupOldSupportEmails } = require('./utils/emailCleanup');
const { runBlogAutoPublish } = require('./utils/blogAutoPublish');
const pricingRoutes = require('./routes/pricing');
const subscriptionsRoutes = require('./routes/subscriptions');
const inboundEmailRoutes = require('./routes/inbound-email');
const emailTemplatesRoutes = require('./routes/email-templates');
const statusMonitor = require('./lib/statusMonitor');
const { ensureConsentTable } = require('./utils/consent');
const { ensureStatusSubscriberColumns } = require('./lib/statusNotify');

const app = express();

app.set('trust proxy', 1);

app.use(express.json({ limit: '30mb' }));
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
    credentials: true,
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

const MAINTENANCE_FLAG_PATH = path.join(__dirname, '.maintenance');
app.get('/api/maintenance-status', (req, res) => {
  const enabled = fs.existsSync(MAINTENANCE_FLAG_PATH);
  res.json({ enabled });
});

app.post('/api/maintenance-toggle', requireAdmin, (req, res) => {
  const enabled = fs.existsSync(MAINTENANCE_FLAG_PATH);
  if (enabled) {
    fs.unlinkSync(MAINTENANCE_FLAG_PATH);
  } else {
    fs.writeFileSync(MAINTENANCE_FLAG_PATH, '');
  }
  res.json({ enabled: !enabled });
});

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/service-tickets', serviceTicketsRoutes);
app.use('/api/promo-codes', promoCodesRoutes);
app.use('/api/bans', bansRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/bot', botRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/enterprise', enterpriseRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/blog-cms', blogCmsRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/inbound-email', inboundEmailRoutes);
app.use('/api/email-templates', emailTemplatesRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
ensureConsentTable();
ensureStatusSubscriberColumns();

app.listen(PORT, () => {
  console.log(`Antviz backend запущен на порту ${PORT}`);
  statusMonitor.start();

  setTimeout(() => checkExpiringSubscriptions().catch((e) => console.error('checkExpiringSubscriptions:', e)), 60 * 1000);
  setInterval(() => checkExpiringSubscriptions().catch((e) => console.error('checkExpiringSubscriptions:', e)), 6 * 60 * 60 * 1000);

  setTimeout(() => cleanupOldSupportEmails().catch((e) => console.error('cleanupOldSupportEmails:', e)), 90 * 1000);
  setInterval(() => cleanupOldSupportEmails().catch((e) => console.error('cleanupOldSupportEmails:', e)), 24 * 60 * 60 * 1000);

  setTimeout(() => runBlogAutoPublish(), 120 * 1000);
  setInterval(() => runBlogAutoPublish(), 3 * 60 * 60 * 1000);
});
