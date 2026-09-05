const express = require('express');
const os = require('os');
const { exec } = require('child_process');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// df -h недоступен на Windows и падает на некоторых минимальных образах —
// оборачиваем в промис с таймаутом, чтобы одна зависшая команда не роняла
// весь ответ /api/system/stats.
function getDiskUsage() {
  return new Promise((resolve) => {
    exec('df -kP /', { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const lines = stdout.trim().split('\n');
      if (lines.length < 2) return resolve(null);
      // Filesystem 1024-blocks Used Available Capacity Mounted
      const parts = lines[1].trim().split(/\s+/);
      if (parts.length < 5) return resolve(null);
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      const availKb = Number(parts[3]);
      if (!totalKb) return resolve(null);
      resolve({
        totalBytes: totalKb * 1024,
        usedBytes: usedKb * 1024,
        availBytes: availKb * 1024,
        usedPercent: Math.round((usedKb / totalKb) * 100),
      });
    });
  });
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d} д`);
  if (h) parts.push(`${h} ч`);
  parts.push(`${m} мин`);
  return parts.join(' ');
}

// ── GET /api/system/stats ── память/диск сервера + бизнес-статистика (только админ) ──
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const proc = process.memoryUsage();

    const disk = await getDiskUsage();

    // ── Бизнес-статистика для графиков ──
    const [
      usersCountR,
      ordersByStatusR,
      revenueByMonthR,
      ticketsR,
      serviceTicketsR,
      enterpriseR,
      newUsersByMonthR,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM users'),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM orders WHERE status != -1 GROUP BY status ORDER BY status`),
      pool.query(`
        SELECT to_char(date_trunc('month', COALESCE(paid_at, created_at)), 'YYYY-MM') AS month,
               COALESCE(SUM(total_price),0) AS revenue
        FROM orders
        WHERE paid = TRUE AND COALESCE(paid_at, created_at) > now() - interval '6 months'
        GROUP BY 1 ORDER BY 1`),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM tickets GROUP BY status`),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM service_tickets GROUP BY status`),
      pool.query(`SELECT status, COUNT(*)::int AS n FROM enterprise_applications GROUP BY status`),
      pool.query(`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
               COUNT(*)::int AS n
        FROM users
        WHERE created_at > now() - interval '6 months'
        GROUP BY 1 ORDER BY 1`),
    ]);

    res.json({
      server: {
        memory: {
          totalBytes: totalMem,
          usedBytes: usedMem,
          freeBytes: freeMem,
          usedPercent: Math.round((usedMem / totalMem) * 100),
        },
        disk,
        process: {
          rss: proc.rss,
          heapUsed: proc.heapUsed,
          heapTotal: proc.heapTotal,
        },
        loadavg: os.loadavg(),
        cpus: os.cpus().length,
        uptimeSeconds: os.uptime(),
        uptimeLabel: fmtUptime(os.uptime()),
        nodeVersion: process.version,
        platform: `${os.platform()} ${os.release()}`,
      },
      business: {
        usersCount: usersCountR.rows[0].n,
        ordersByStatus: ordersByStatusR.rows,
        revenueByMonth: revenueByMonthR.rows.map((r) => ({ month: r.month, revenue: Number(r.revenue) })),
        newUsersByMonth: newUsersByMonthR.rows,
        ticketsByStatus: ticketsR.rows,
        serviceTicketsByStatus: serviceTicketsR.rows,
        enterpriseByStatus: enterpriseR.rows,
      },
    });
  } catch (err) {
    console.error('GET /api/system/stats:', err);
    res.status(500).json({ error: 'Не удалось получить статистику сервера' });
  }
});

module.exports = router;
