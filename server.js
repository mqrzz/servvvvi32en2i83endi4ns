require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const authRoutes = require('./routes/auth');
const sessionsRoutes = require('./routes/sessions');
const ordersRoutes = require('./routes/orders');
const notificationsRoutes = require('./routes/notifications');
const ticketsRoutes = require('./routes/tickets');
const serviceTicketsRoutes = require('./routes/service-tickets');

const app = express();

// Сервер стоит за nginx (reverse proxy), поэтому нужно доверять
// заголовку X-Forwarded-For, чтобы req.ip и express-rate-limit
// корректно определяли реальный IP клиента, а не падали с ошибкой.
app.set('trust proxy', 1);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN,
    credentials: true,
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Тех.работы: включаются/выключаются простым файлом-флагом на сервере ──
// touch .maintenance  → включить
// rm .maintenance     → выключить
// Не требует перезапуска сервиса — проверяется на каждый запрос (дёшево,
// это просто проверка существования файла на диске).
const MAINTENANCE_FLAG_PATH = path.join(__dirname, '.maintenance');
app.get('/api/maintenance-status', (req, res) => {
  const enabled = fs.existsSync(MAINTENANCE_FLAG_PATH);
  res.json({ enabled });
});

app.use('/api/auth', authRoutes);
app.use('/api/sessions', sessionsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/tickets', ticketsRoutes);
app.use('/api/service-tickets', serviceTicketsRoutes);

// Единый обработчик ошибок — чтобы стектрейсы не улетали на фронт
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Antviz backend запущен на порту ${PORT}`);
});
