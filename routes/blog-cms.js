const express = require('express');
const { Octokit } = require('@octokit/rest');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// ── Настройка GitHub-клиента ──
// GITHUB_TOKEN — fine-grained PAT с правами ТОЛЬКО на репозиторий блога
// (Contents: Read and write, ничего больше не нужно).
// GITHUB_BLOG_REPO — в формате "owner/repo", например "mqrzz/bloggggg2weefgwe".
// GITHUB_BLOG_BRANCH — обычно "main".
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [OWNER, REPO] = (process.env.GITHUB_BLOG_REPO || '').split('/');
const BRANCH = process.env.GITHUB_BLOG_BRANCH || 'main';

if (!OWNER || !REPO) {
  console.error('blog-cms: GITHUB_BLOG_REPO не задан или задан неверно (ожидается "owner/repo")');
}

// Чтобы каждый роут не проверял это руками
function ghReady(req, res, next) {
  if (!process.env.GITHUB_TOKEN || !OWNER || !REPO) {
    return res.status(500).json({ error: 'GitHub-интеграция блога не настроена (проверь GITHUB_TOKEN / GITHUB_BLOG_REPO в .env)' });
  }
  next();
}

// Простая защита от path traversal — path всегда должен быть внутри /content/
function safePath(p) {
  if (typeof p !== 'string' || !p.startsWith('content/') || p.includes('..')) return null;
  return p;
}

// ── GET /api/blog-cms/list?dir=content/articles ── список файлов в папке репозитория ──
router.get('/list', requireAdmin, ghReady, async (req, res) => {
  const dir = safePath(req.query.dir || '');
  if (!dir) return res.status(400).json({ error: 'Некорректный путь' });

  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: dir, ref: BRANCH });
    if (!Array.isArray(data)) return res.status(400).json({ error: 'Указанный путь — не папка' });
    res.json(
      data
        .filter((item) => item.type === 'file')
        .map((item) => ({ name: item.name, path: item.path, size: item.size, sha: item.sha }))
    );
  } catch (err) {
    if (err.status === 404) return res.json([]); // папки ещё нет — это нормально для первого запуска
    console.error('blog-cms /list:', err);
    res.status(500).json({ error: 'Не удалось получить список файлов из репозитория' });
  }
});

// ── GET /api/blog-cms/content?path=content/articles/slug.md ── содержимое одного файла ──
router.get('/content', requireAdmin, ghReady, async (req, res) => {
  const filePath = safePath(req.query.path || '');
  if (!filePath) return res.status(400).json({ error: 'Некорректный путь' });

  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: filePath, ref: BRANCH });
    if (Array.isArray(data)) return res.status(400).json({ error: 'Указанный путь — папка, а не файл' });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    res.json({ path: filePath, content, sha: data.sha });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Файл не найден' });
    console.error('blog-cms /content GET:', err);
    res.status(500).json({ error: 'Не удалось получить файл из репозитория' });
  }
});

// ── PUT /api/blog-cms/content ── создать или обновить файл (коммит в репозиторий) ──
// body: { path, content, message, sha? }
// sha нужен, только если файл уже существует и мы его обновляем — GitHub API
// требует знать sha текущей версии, чтобы не перезаписать чужие изменения вслепую.
router.put('/content', requireAdmin, ghReady, async (req, res) => {
  const filePath = safePath(req.body?.path);
  const content = req.body?.content;
  const message = req.body?.message || `Обновление: ${filePath}`;
  const sha = req.body?.sha; // undefined при создании нового файла — это ок

  if (!filePath || typeof content !== 'string') {
    return res.status(400).json({ error: 'Нужны поля path и content' });
  }

  try {
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner: OWNER,
      repo: REPO,
      path: filePath,
      message,
      content: Buffer.from(content, 'utf-8').toString('base64'),
      sha: sha || undefined,
      branch: BRANCH,
      committer: { name: 'Antviz Blog CMS', email: 'noreply@antviz.ru' },
    });
    res.json({ ok: true, sha: data.content.sha, commitUrl: data.commit.html_url });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ error: 'Файл изменился с момента открытия — обновите страницу и попробуйте снова' });
    }
    console.error('blog-cms /content PUT:', err);
    res.status(500).json({ error: 'Не удалось сохранить файл в репозитории' });
  }
});

// ── DELETE /api/blog-cms/content ── удалить файл ──
// body: { path, sha, message? }
router.delete('/content', requireAdmin, ghReady, async (req, res) => {
  const filePath = safePath(req.body?.path);
  const sha = req.body?.sha;
  const message = req.body?.message || `Удаление: ${filePath}`;

  if (!filePath || !sha) {
    return res.status(400).json({ error: 'Нужны поля path и sha' });
  }

  try {
    await octokit.repos.deleteFile({
      owner: OWNER,
      repo: REPO,
      path: filePath,
      message,
      sha,
      branch: BRANCH,
      committer: { name: 'Antviz Blog CMS', email: 'noreply@antviz.ru' },
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('blog-cms /content DELETE:', err);
    res.status(500).json({ error: 'Не удалось удалить файл из репозитория' });
  }
});

// ── POST /api/blog-cms/image ── загрузить картинку (base64) в репозиторий ──
// body: { path (например "img/uploads/cover-2026-11-05.png"), base64 }
router.post('/image', requireAdmin, ghReady, async (req, res) => {
  const filePath = req.body?.path;
  const base64 = req.body?.base64;

  if (typeof filePath !== 'string' || !filePath.startsWith('img/uploads/') || filePath.includes('..')) {
    return res.status(400).json({ error: 'Картинки можно загружать только в img/uploads/' });
  }
  if (typeof base64 !== 'string' || base64.length < 10) {
    return res.status(400).json({ error: 'Нужно поле base64 с содержимым файла' });
  }
  // грубая защита от слишком больших файлов (base64 раздувает размер ~на треть)
  if (base64.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'Файл слишком большой (максимум ~6 МБ)' });
  }

  try {
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner: OWNER,
      repo: REPO,
      path: filePath,
      message: `Загрузка изображения: ${filePath}`,
      content: base64,
      branch: BRANCH,
      committer: { name: 'Antviz Blog CMS', email: 'noreply@antviz.ru' },
    });
    res.json({ ok: true, path: filePath, url: `https://blog.antviz.ru/${filePath}`, sha: data.content.sha });
  } catch (err) {
    console.error('blog-cms /image POST:', err);
    res.status(500).json({ error: 'Не удалось загрузить изображение в репозиторий' });
  }
});

// ── GET /api/blog-cms/build-status ── последний запуск сборки (GitHub Actions) ──
router.get('/build-status', requireAdmin, ghReady, async (req, res) => {
  try {
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner: OWNER,
      repo: REPO,
      branch: BRANCH,
      per_page: 1,
    });
    const run = data.workflow_runs[0];
    if (!run) return res.json({ status: 'none' });
    res.json({
      status: run.status,        // queued | in_progress | completed
      conclusion: run.conclusion, // success | failure | null
      url: run.html_url,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    });
  } catch (err) {
    console.error('blog-cms /build-status:', err);
    res.status(500).json({ error: 'Не удалось получить статус сборки' });
  }
});

module.exports = router;
