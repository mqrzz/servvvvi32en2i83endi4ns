const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();
router.use(requireAdmin); // вся почта поддержки — только для админа, публичной части здесь нет

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error(`email-templates.js ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: 'Внутренняя ошибка' });
  });
}

function toClient(t) {
  return {
    id: t.id,
    title: t.title,
    subject: t.subject,
    body: t.body,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM email_templates ORDER BY title ASC');
  res.json(rows.map(toClient));
}));

router.post('/', wrap(async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Укажите название шаблона' });
  const { rows } = await pool.query(
    'INSERT INTO email_templates (title, subject, body) VALUES ($1,$2,$3) RETURNING *',
    [title, req.body.subject || '', req.body.body || '']
  );
  res.json(toClient(rows[0]));
}));

router.put('/:id', wrap(async (req, res) => {
  const title = (req.body.title || '').trim();
  if (!title) return res.status(400).json({ error: 'Укажите название шаблона' });
  const { rows } = await pool.query(
    `UPDATE email_templates SET title=$1, subject=$2, body=$3, updated_at=now() WHERE id=$4 RETURNING *`,
    [title, req.body.subject || '', req.body.body || '', req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Шаблон не найден' });
  res.json(toClient(rows[0]));
}));

router.delete('/:id', wrap(async (req, res) => {
  const { rows } = await pool.query('DELETE FROM email_templates WHERE id=$1 RETURNING id', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Шаблон не найден' });
  res.json({ ok: true });
}));

module.exports = router;
