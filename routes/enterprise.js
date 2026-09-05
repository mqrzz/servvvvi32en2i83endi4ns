const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');
const { sendEnterpriseApplicationAdminEmail, sendEnterpriseApplicationConfirmationEmail } = require('../utils/mailer');

const router = express.Router();

function toClient(a) {
  return {
    id: a.id,
    name: a.name,
    company: a.company,
    telegramUsername: a.telegram_username,
    email: a.email,
    phone: a.phone,
    projectType: a.project_type,
    description: a.description,
    ownServer: a.own_server,
    serversInRf: a.servers_in_rf,
    customLimits: a.custom_limits,
    expectedLoad: a.expected_load,
    budget: a.budget,
    timeline: a.timeline,
    status: a.status,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// Расширенная версия для админки — с внутренними заметками
function toAdmin(a) {
  return { ...toClient(a), adminNotes: a.admin_notes || '' };
}

// ── POST /api/enterprise ── публичная форма (без авторизации) ──
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    const telegramUsername = (b.telegramUsername || '').trim();
    const email = (b.email || '').trim();
    const description = (b.description || '').trim();

    if (!name || !telegramUsername || !email || !description) {
      return res.status(400).json({ error: 'Заполните имя, Telegram, email и описание проекта' });
    }

    const serversInRf = ['yes', 'no', 'no_matter'].includes(b.serversInRf) ? b.serversInRf : null;

    const { rows } = await pool.query(
      `INSERT INTO enterprise_applications (
        name, company, telegram_username, email, phone, project_type, description,
        own_server, servers_in_rf, custom_limits, expected_load, budget, timeline
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        name, b.company || null, telegramUsername, email, b.phone || null,
        b.projectType || null, description,
        !!b.ownServer, serversInRf, !!b.customLimits,
        b.expectedLoad || null, b.budget || null, b.timeline || null,
      ]
    );
    const application = rows[0];

    // Уведомление админу о новой заявке — не блокирует и не роняет ответ клиенту,
    // если письмо по какой-то причине не ушло.
    sendEnterpriseApplicationAdminEmail(application).catch((e) =>
      console.error('Не удалось отправить письмо о новой заявке (админ):', e)
    );
    // Подтверждение клиенту, что заявка принята.
    sendEnterpriseApplicationConfirmationEmail(application.email, application.name).catch((e) =>
      console.error('Не удалось отправить письмо о новой заявке (клиент):', e)
    );

    res.json(toClient(application));
  } catch (err) {
    console.error('create enterprise application error:', err);
    res.status(500).json({ error: 'Не удалось отправить заявку, попробуйте ещё раз' });
  }
});

// ── GET /api/enterprise/admin/all ── все заявки (только админ) ──
router.get('/admin/all', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM enterprise_applications ORDER BY created_at DESC');
  res.json(rows.map(toAdmin));
});

// ── GET /api/enterprise/:id ── одна заявка (только админ) ──
router.get('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM enterprise_applications WHERE id = $1', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(toAdmin(rows[0]));
});

// ── PATCH /api/enterprise/:id ── статус и заметки (только админ) ──
router.patch('/:id', requireAdmin, async (req, res) => {
  const sets = [];
  const values = [];
  let i = 1;
  if (req.body.status !== undefined) {
    if (!['new', 'in_progress', 'done', 'declined'].includes(req.body.status)) {
      return res.status(400).json({ error: 'Некорректный статус' });
    }
    sets.push(`status = $${i++}`);
    values.push(req.body.status);
  }
  if (req.body.adminNotes !== undefined) {
    sets.push(`admin_notes = $${i++}`);
    values.push(req.body.adminNotes);
  }
  if (!sets.length) return res.status(400).json({ error: 'Нечего обновлять' });
  values.push(req.params.id);

  const { rows } = await pool.query(
    `UPDATE enterprise_applications SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json(toAdmin(rows[0]));
});

// ── DELETE /api/enterprise/:id ── удалить заявку (только админ) ──
router.delete('/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM enterprise_applications WHERE id = $1 RETURNING id', [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Заявка не найдена' });
  res.json({ ok: true });
});

module.exports = router;
