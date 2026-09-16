const express = require('express');
const { Octokit } = require('@octokit/rest');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

// ── Настройка GitHub-клиента ──
// GITHUB_TOKEN — fine-grained PAT с правами Contents: Read and write на репозиторий блога.
// GITHUB_BLOG_REPO — "owner/repo", например "mqrzz/bloggggg2weefgwe".
// GITHUB_BLOG_BRANCH — обычно "main".
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [OWNER, REPO] = (process.env.GITHUB_BLOG_REPO || '').split('/');
const BRANCH = process.env.GITHUB_BLOG_BRANCH || 'main';
const SITE = 'https://blog.antviz.ru';

if (!OWNER || !REPO) {
  console.error('blog-cms: GITHUB_BLOG_REPO не задан или задан неверно (ожидается "owner/repo")');
}

function ghReady(req, res, next) {
  if (!process.env.GITHUB_TOKEN || !OWNER || !REPO) {
    return res.status(500).json({ error: 'GitHub-интеграция блога не настроена (проверь GITHUB_TOKEN / GITHUB_BLOG_REPO в .env)' });
  }
  next();
}

// ── Реальная структура репозитория (НЕ content/articles — это плоская папка articles/ в корне) ──
const ARTICLES_DIR = 'articles';
const ARTICLES_INDEX = 'articles/index.html';
const HOME_INDEX = 'index.html';
const SITEMAP_PATH = 'sitemap.xml';
const FEED_PATH = 'feed.xml';
const HOME_CARDS_LIMIT = 6; // сколько последних статей показывать на главной

// Границы «редактируемого тела» внутри HTML-файла статьи — всё остальное
// (стили, скрипты, кнопка «наверх», куки-баннер) не трогаем вообще.
const NAV_SCRIPT = '<script src="https://blog.antviz.ru/blog-nav.js" data-page="articles"></script>';
const FOOTER_BTN_MARK = '<button class="back-to-top"';

function safePathForGeneric(p) {
  if (typeof p !== 'string' || p.includes('..')) return null;
  if (p === ARTICLES_DIR || p.startsWith(`${ARTICLES_DIR}/`)) return p;
  return null;
}

// ── Библиотека иконок для карточек — это те же самые SVG, что уже используются
// в дизайне (взято из articles/index.html), чтобы новые карточки не выбивались стилем. ──
const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
  shield: '<path d="M12 2 4 6v6c0 5 3.4 8.4 8 10 4.6-1.6 8-5 8-10V6z"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  chart: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  chartUp: '<path d="M3 3v18h18"/><path d="M7 16l4-6 4 3 5-8"/>',
  bars: '<path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="5"/><rect x="14" y="8" width="3" height="9"/>',
  ruler: '<path d="M4 20h16M9 20 12 4l3 16M7 14h10"/>',
  telegram: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  arrows: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18M15 3v18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  device: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const ICON_SVG_WRAP = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const ARROW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

router.get('/icons', requireAdmin, (req, res) => {
  res.json(Object.keys(ICONS).map((key) => ({ key, svg: ICON_SVG_WRAP(ICONS[key]) })));
});

// ── slug ──
function slugify(s) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return String(s || '').toLowerCase().split('').map((ch) => map[ch] !== undefined ? map[ch] : ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'stranica';
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escAttr(s) { return escHtml(s).replace(/\n/g, ' '); }
function escJson(s) { return JSON.stringify(String(s || '')).slice(1, -1); }

function ruDate(iso) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function rfc822Date(iso) {
  const d = new Date(iso + 'T12:00:00+03:00');
  return d.toUTCString().replace('GMT', '+0300');
}
function readingTimeMinutes(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// ────────────────────────────────────────────────────────────────
// Работа с содержимым файла статьи: голова (SEO-теги) патчится точечно,
// «тело» (всё между подключением nav и кнопкой «наверх») — редактируется
// админом как есть, сырым HTML, мы его не разбираем и не перегенерируем.
// ────────────────────────────────────────────────────────────────
function splitArticle(html) {
  const startIdx = html.indexOf(NAV_SCRIPT);
  const endIdx = html.indexOf(FOOTER_BTN_MARK);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  const bodyStart = startIdx + NAV_SCRIPT.length;
  return {
    head: html.slice(0, bodyStart),
    body: html.slice(bodyStart, endIdx),
    tail: html.slice(endIdx),
  };
}

function extractMeta(html) {
  const get = (re) => { const m = html.match(re); return m ? m[1] : ''; };
  return {
    title: get(/<title>([\s\S]*?)<\/title>/),
    description: get(/<meta name="description" content="([^"]*)"/),
    ogImage: get(/<meta property="og:image" content="([^"]*)"/),
    category: get(/<meta property="article:section" content="([^"]*)"/),
    publishedTime: get(/<meta property="article:published_time" content="([^"]*)"/).slice(0, 10),
  };
}

// Точечно заменяет только известные теги в <head>, остальное (стили, favicon,
// manifest и т.д.) остаётся байт-в-байт как было.
function patchHead(head, f) {
  const isoDate = f.publishedDate; // YYYY-MM-DD
  const isoTime = `${isoDate}T12:00:00+03:00`;
  const url = `${SITE}/articles/${f.slug}`;
  const replacements = [
    [/<title>[\s\S]*?<\/title>/, `<title>${escHtml(f.title)} | Блог Antviz</title>`],
    [/<meta name="description" content="[^"]*"/, `<meta name="description" content="${escAttr(f.description)}"`],
    [/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${url}"`],
    [/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${escAttr(f.title)} — Блог Antviz"`],
    [/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${escAttr(f.description)}"`],
    [/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${url}"`],
    [/<meta property="og:image" content="[^"]*"/, `<meta property="og:image" content="${escAttr(f.ogImage)}"`],
    [/<meta property="article:published_time" content="[^"]*"/, `<meta property="article:published_time" content="${isoTime}"`],
    [/<meta property="article:section" content="[^"]*"/, `<meta property="article:section" content="${escAttr(f.category)}"`],
    [/<meta name="twitter:image" content="[^"]*"/, `<meta name="twitter:image" content="${escAttr(f.ogImage)}"`],
    [/<meta name="twitter:title" content="[^"]*"/, `<meta name="twitter:title" content="${escAttr(f.title)} — Блог Antviz"`],
    [/<meta name="twitter:description" content="[^"]*"/, `<meta name="twitter:description" content="${escAttr(f.description)}"`],
    [/"headline":\s*"[^"]*"/, `"headline": "${escJson(f.title)}"`],
    [/"datePublished":\s*"[^"]*"/, `"datePublished": "${isoDate}"`],
    [/("@type":\s*"Article"[\s\S]{0,300}?"description":\s*)"[^"]*"/, `$1"${escJson(f.description)}"`],
    [/("@type":\s*"WebPage",\s*"@id":\s*)"[^"]*"/, `$1"${url}"`],
    [/(BreadcrumbList[\s\S]*?"position":\s*3,\s*"name":\s*)"[^"]*"(,\s*"item":\s*)"[^"]*"/, `$1"${escJson(f.title)}"$2"${url}"`],
  ];
  let out = head;
  for (const [re, val] of replacements) out = out.replace(re, val);
  return out;
}

function buildArticleHtml({ f, body, tail, head }) {
  const patchedHead = patchHead(head, f);
  return patchedHead + body + tail;
}

// ── Клонирование существующей статьи как каркаса для новой ──
async function cloneSkeleton(cloneSlug) {
  const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: `${ARTICLES_DIR}/${cloneSlug}.html`, ref: BRANCH });
  const html = Buffer.from(data.content, 'base64').toString('utf-8');
  const split = splitArticle(html);
  if (!split) throw new Error('Не удалось разобрать структуру исходной статьи для клонирования');
  const oldMeta = extractMeta(html);
  return { ...split, oldMeta };
}

// ────────────────────────────────────────────────────────────────
// Карточки на articles/index.html и на главной — простые точечные
// вставки/замены/удаления по slug, без риска для остального макета.
// ────────────────────────────────────────────────────────────────
function buildIndexCard(f) {
  return `      <a href="${f.slug}" class="a-card reveal">
        <div class="ico">${ICON_SVG_WRAP(ICONS[f.icon] || ICONS.grid)}</div>
        <span class="tag">${escHtml(f.category)}</span>
        <h3>${escHtml(f.cardTitle)}</h3>
        <p>${escHtml(f.excerpt)}</p>
        <div class="read">Читать ${ARROW_ICON}</div>
      </a>`;
}
function buildHomeCard(f) {
  return `      <a href="articles/${f.slug}" class="news-card reveal">
        <div class="ico">${ICON_SVG_WRAP(ICONS[f.icon] || ICONS.grid)}</div>
        <span class="tag">${escHtml(f.category)}</span>
        <h3>${escHtml(f.cardTitle)}</h3>
        <p>${escHtml(f.excerpt)}</p>
        <div class="cardfoot">
          <div class="read">Читать ${ARROW_ICON}</div>
          <div class="rtime">${CLOCK_ICON}${f.readingTime} мин</div>
        </div>
      </a>`;
}

function cardRegexFor(slug, cls) {
  const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\n?[ \\t]*<a href="(?:articles/)?${esc}"[^>]*class="${cls}[^"]*"[\\s\\S]*?<\\/a>`, '');
}

function upsertCard(html, slug, cls, newCardBlock) {
  const re = cardRegexFor(slug, cls);
  if (re.test(html)) {
    return html.replace(re, '\n' + newCardBlock);
  }
  const firstCardRe = new RegExp(`([ \\t]*)<a href="[^"]*"[^>]*class="${cls}[^"]*"`);
  const m = html.match(firstCardRe);
  if (!m) return html;
  const insertAt = m.index;
  return html.slice(0, insertAt) + newCardBlock + '\n\n' + html.slice(insertAt);
}

function removeCard(html, slug, cls) {
  const re = cardRegexFor(slug, cls);
  return html.replace(re, '');
}

function capHomeCards(html, limit) {
  const re = /<a href="articles\/[^"]*"[^>]*class="news-card[^"]*"[\s\S]*?<\/a>/g;
  const matches = [...html.matchAll(re)];
  if (matches.length <= limit) return html;
  for (const m of matches.slice(limit)) {
    html = html.replace(m[0], '');
  }
  return html;
}

// ────────────────────────────────────────────────────────────────
// sitemap.xml / feed.xml
// ────────────────────────────────────────────────────────────────
function upsertSitemap(xml, slug) {
  const url = `${SITE}/articles/${slug}`;
  if (xml.includes(`<loc>${url}</loc>`)) return xml;
  const entry = `  <url>\n    <loc>${url}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
  return xml.replace('</urlset>', entry + '</urlset>');
}
function removeSitemap(xml, slug) {
  const url = `${SITE}/articles/${slug}`;
  const re = new RegExp(`\\s*<url>\\s*<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/loc>[\\s\\S]*?<\\/url>`);
  return xml.replace(re, '');
}
function upsertFeed(xml, f) {
  const url = `${SITE}/articles/${f.slug}`;
  const entry = `  <item>\n    <title>${escHtml(f.title)}</title>\n    <link>${url}</link>\n    <guid>${url}</guid>\n    <pubDate>${rfc822Date(f.publishedDate)}</pubDate>\n    <description>${escHtml(f.excerpt)}</description>\n  </item>\n`;
  const re = new RegExp(`\\s*<item>\\s*<title>[\\s\\S]*?<link>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/link>[\\s\\S]*?<\\/item>`);
  let out = xml.replace(re, '');
  const firstItem = out.indexOf('<item>');
  if (firstItem === -1) return out.replace('</channel>', entry + '</channel>');
  return out.slice(0, firstItem) + entry + '\n' + out.slice(firstItem);
}
function removeFeed(xml, slug) {
  const url = `${SITE}/articles/${slug}`;
  const re = new RegExp(`\\s*<item>\\s*<title>[\\s\\S]*?<link>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/link>[\\s\\S]*?<\\/item>`);
  return xml.replace(re, '');
}

// ────────────────────────────────────────────────────────────────
// Атомарный коммит нескольких файлов разом (Git Data API) — вместо
// 5 отдельных коммитов на каждое сохранение статьи.
// ────────────────────────────────────────────────────────────────
async function getFile(path) {
  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path, ref: BRANCH });
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function commitFiles(files, message) {
  const { data: ref } = await octokit.git.getRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}` });
  const baseSha = ref.object.sha;
  const { data: baseCommit } = await octokit.git.getCommit({ owner: OWNER, repo: REPO, commit_sha: baseSha });

  const tree = await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      if (content === null) return { path, mode: '100644', type: 'blob', sha: null };
      const { data: blob } = await octokit.git.createBlob({ owner: OWNER, repo: REPO, content: Buffer.from(content, 'utf-8').toString('base64'), encoding: 'base64' });
      return { path, mode: '100644', type: 'blob', sha: blob.sha };
    })
  );

  const { data: newTree } = await octokit.git.createTree({ owner: OWNER, repo: REPO, base_tree: baseCommit.tree.sha, tree });
  const { data: newCommit } = await octokit.git.createCommit({ owner: OWNER, repo: REPO, message, tree: newTree.sha, parents: [baseSha] });
  await octokit.git.updateRef({ owner: OWNER, repo: REPO, ref: `heads/${BRANCH}`, sha: newCommit.sha });
  return newCommit.sha;
}

// ────────────────────────────────────────────────────────────────
// РОУТЫ
// ────────────────────────────────────────────────────────────────

let listCache = null;
router.get('/articles', requireAdmin, ghReady, async (req, res) => {
  try {
    if (listCache && Date.now() - listCache.at < 30_000) return res.json(listCache.data);
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: ARTICLES_DIR, ref: BRANCH });
    const files = data.filter((f) => f.type === 'file' && f.name.endsWith('.html') && f.name !== 'index.html');
    const items = await Promise.all(files.map(async (f) => {
      const slug = f.name.replace(/\.html$/, '');
      const html = await getFile(f.path);
      const meta = extractMeta(html);
      const draft = /<meta name="robots" content="noindex"/.test(html);
      return {
        slug,
        title: meta.title.replace(/\s*\|\s*Блог Antviz\s*$/, ''),
        description: meta.description,
        category: meta.category,
        ogImage: meta.ogImage,
        publishedDate: meta.publishedTime,
        draft,
      };
    }));
    items.sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || ''));
    listCache = { at: Date.now(), data: items };
    res.json(items);
  } catch (err) {
    console.error('blog-cms GET /articles:', err);
    res.status(500).json({ error: 'Не удалось получить список статей' });
  }
});

router.get('/articles/:slug', requireAdmin, ghReady, async (req, res) => {
  try {
    const html = await getFile(`${ARTICLES_DIR}/${req.params.slug}.html`);
    if (!html) return res.status(404).json({ error: 'Статья не найдена' });
    const split = splitArticle(html);
    if (!split) return res.status(500).json({ error: 'Не удалось разобрать структуру файла статьи (нестандартный формат)' });
    const meta = extractMeta(html);
    const draft = /<meta name="robots" content="noindex"/.test(html);
    const indexHtml = await getFile(ARTICLES_INDEX);
    const cardMatch = indexHtml && indexHtml.match(cardRegexFor(req.params.slug, 'a-card'));
    const excerptMatch = cardMatch && cardMatch[0].match(/<p>([\s\S]*?)<\/p>/);
    res.json({
      slug: req.params.slug,
      title: meta.title.replace(/\s*\|\s*Блог Antviz\s*$/, ''),
      description: meta.description,
      category: meta.category,
      ogImage: meta.ogImage,
      publishedDate: meta.publishedTime,
      excerpt: excerptMatch ? excerptMatch[1] : '',
      draft,
      bodyHtml: split.body,
      readingTime: readingTimeMinutes(split.body),
    });
  } catch (err) {
    console.error('blog-cms GET /articles/:slug:', err);
    res.status(500).json({ error: 'Не удалось загрузить статью' });
  }
});

router.get('/articles-for-clone', requireAdmin, ghReady, async (req, res) => {
  try {
    if (listCache && Date.now() - listCache.at < 30_000) {
      return res.json(listCache.data.map((a) => ({ slug: a.slug, title: a.title })));
    }
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: ARTICLES_DIR, ref: BRANCH });
    const files = data.filter((f) => f.type === 'file' && f.name.endsWith('.html') && f.name !== 'index.html');
    res.json(files.map((f) => ({ slug: f.name.replace(/\.html$/, ''), title: f.name })));
  } catch (err) {
    res.status(500).json({ error: 'Не удалось получить список статей' });
  }
});

function validateFields(b) {
  if (!b.title || !b.title.trim()) return 'Укажите заголовок';
  if (!b.category || !b.category.trim()) return 'Укажите категорию';
  if (!b.publishedDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.publishedDate)) return 'Укажите дату публикации';
  if (!b.bodyHtml || !b.bodyHtml.trim()) return 'Тело статьи не может быть пустым';
  return null;
}

router.post('/articles', requireAdmin, ghReady, async (req, res) => {
  const b = req.body || {};
  const err = validateFields(b);
  if (err) return res.status(400).json({ error: err });
  if (!b.cloneFrom) return res.status(400).json({ error: 'Укажите статью-каркас для клонирования (cloneFrom)' });

  try {
    const slug = slugify(b.slug || b.title);
    const existing = await getFile(`${ARTICLES_DIR}/${slug}.html`);
    if (existing) return res.status(409).json({ error: 'Статья с таким адресом (slug) уже существует' });

    const skeleton = await cloneSkeleton(b.cloneFrom);
    const f = {
      slug, title: b.title.trim(), description: (b.description || '').trim(),
      category: b.category.trim(), ogImage: b.ogImage || '', publishedDate: b.publishedDate,
      cardTitle: b.title.trim(), excerpt: (b.excerpt || '').trim(), icon: b.icon || 'grid',
      readingTime: readingTimeMinutes(b.bodyHtml),
    };

    let body = b.bodyHtml;
    if (skeleton.oldMeta.title) {
      const oldClean = skeleton.oldMeta.title.replace(/\s*\|\s*Блог Antviz\s*$/, '');
      body = body.split(oldClean).join(f.title);
    }
    if (skeleton.oldMeta.category) body = body.split(skeleton.oldMeta.category).join(f.category);

    const articleHtml = buildArticleHtml({ f, body, tail: skeleton.tail, head: skeleton.head });
    const finalHtml = b.draft ? insertNoindex(articleHtml) : articleHtml;

    const commitPayload = { [`${ARTICLES_DIR}/${slug}.html`]: finalHtml };
    if (!b.draft) {
      const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
        getFile(ARTICLES_INDEX), getFile(HOME_INDEX), getFile(SITEMAP_PATH), getFile(FEED_PATH),
      ]);
      if (indexHtml) commitPayload[ARTICLES_INDEX] = upsertCard(indexHtml, slug, 'a-card', buildIndexCard(f));
      if (homeHtml) commitPayload[HOME_INDEX] = capHomeCards(upsertCard(homeHtml, slug, 'news-card', buildHomeCard(f)), HOME_CARDS_LIMIT);
      if (sitemapXml) commitPayload[SITEMAP_PATH] = upsertSitemap(sitemapXml, slug);
      if (feedXml) commitPayload[FEED_PATH] = upsertFeed(feedXml, f);
    }

    await commitFiles(commitPayload, `Блог: новая статья «${f.title}»`);
    listCache = null;
    res.json({ ok: true, slug });
  } catch (err) {
    console.error('blog-cms POST /articles:', err);
    res.status(500).json({ error: 'Не удалось создать статью: ' + err.message });
  }
});

router.put('/articles/:slug', requireAdmin, ghReady, async (req, res) => {
  const b = req.body || {};
  const err = validateFields(b);
  if (err) return res.status(400).json({ error: err });
  const slug = req.params.slug;

  try {
    const html = await getFile(`${ARTICLES_DIR}/${slug}.html`);
    if (!html) return res.status(404).json({ error: 'Статья не найдена' });
    const split = splitArticle(html);
    if (!split) return res.status(500).json({ error: 'Не удалось разобрать структуру файла статьи' });

    const f = {
      slug, title: b.title.trim(), description: (b.description || '').trim(),
      category: b.category.trim(), ogImage: b.ogImage || '', publishedDate: b.publishedDate,
      cardTitle: b.title.trim(), excerpt: (b.excerpt || '').trim(), icon: b.icon || 'grid',
      readingTime: readingTimeMinutes(b.bodyHtml),
    };
    let articleHtml = buildArticleHtml({ f, body: b.bodyHtml, tail: split.tail, head: split.head });
    const nowDraft = !!b.draft;
    articleHtml = nowDraft ? insertNoindex(articleHtml) : removeNoindex(articleHtml);

    const commitPayload = { [`${ARTICLES_DIR}/${slug}.html`]: articleHtml };
    const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
      getFile(ARTICLES_INDEX), getFile(HOME_INDEX), getFile(SITEMAP_PATH), getFile(FEED_PATH),
    ]);

    if (nowDraft) {
      if (indexHtml) commitPayload[ARTICLES_INDEX] = removeCard(indexHtml, slug, 'a-card');
      if (homeHtml) commitPayload[HOME_INDEX] = removeCard(homeHtml, slug, 'news-card');
      if (sitemapXml) commitPayload[SITEMAP_PATH] = removeSitemap(sitemapXml, slug);
      if (feedXml) commitPayload[FEED_PATH] = removeFeed(feedXml, slug);
    } else {
      if (indexHtml) commitPayload[ARTICLES_INDEX] = upsertCard(indexHtml, slug, 'a-card', buildIndexCard(f));
      if (homeHtml) commitPayload[HOME_INDEX] = capHomeCards(upsertCard(homeHtml, slug, 'news-card', buildHomeCard(f)), HOME_CARDS_LIMIT);
      if (sitemapXml) commitPayload[SITEMAP_PATH] = upsertSitemap(sitemapXml, slug);
      if (feedXml) commitPayload[FEED_PATH] = upsertFeed(feedXml, f);
    }

    await commitFiles(commitPayload, `Блог: правки в статье «${f.title}»`);
    listCache = null;
    res.json({ ok: true, slug });
  } catch (err) {
    console.error('blog-cms PUT /articles/:slug:', err);
    res.status(500).json({ error: 'Не удалось сохранить статью: ' + err.message });
  }
});

router.delete('/articles/:slug', requireAdmin, ghReady, async (req, res) => {
  const slug = req.params.slug;
  try {
    const html = await getFile(`${ARTICLES_DIR}/${slug}.html`);
    if (!html) return res.status(404).json({ error: 'Статья не найдена' });

    const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
      getFile(ARTICLES_INDEX), getFile(HOME_INDEX), getFile(SITEMAP_PATH), getFile(FEED_PATH),
    ]);
    const commitPayload = { [`${ARTICLES_DIR}/${slug}.html`]: null };
    if (indexHtml) commitPayload[ARTICLES_INDEX] = removeCard(indexHtml, slug, 'a-card');
    if (homeHtml) commitPayload[HOME_INDEX] = removeCard(homeHtml, slug, 'news-card');
    if (sitemapXml) commitPayload[SITEMAP_PATH] = removeSitemap(sitemapXml, slug);
    if (feedXml) commitPayload[FEED_PATH] = removeFeed(feedXml, slug);

    await commitFiles(commitPayload, `Блог: удалена статья «${slug}»`);
    listCache = null;
    res.json({ ok: true });
  } catch (err) {
    console.error('blog-cms DELETE /articles/:slug:', err);
    res.status(500).json({ error: 'Не удалось удалить статью: ' + err.message });
  }
});

function insertNoindex(html) {
  if (/<meta name="robots"/.test(html)) return html;
  return html.replace('</title>', '</title>\n  <meta name="robots" content="noindex" />');
}
function removeNoindex(html) {
  return html.replace(/\s*<meta name="robots" content="noindex"\s*\/?>/, '');
}

router.post('/image', requireAdmin, ghReady, async (req, res) => {
  const { fileName, base64, folder } = req.body || {};
  if (!fileName || !base64 || base64.length < 10) return res.status(400).json({ error: 'Некорректные данные файла' });
  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  const dir = `img/${(folder || 'og').replace(/[^a-z0-9-]/g, '')}`;
  const path = `${dir}/${Date.now()}-${safeName}`;
  try {
    const match = /^data:([^;]+);base64,(.+)$/.exec(base64);
    const content = match ? match[2] : base64;
    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER, repo: REPO, path, message: `Блог: загружена картинка ${safeName}`, content, branch: BRANCH,
    });
    res.json({ ok: true, url: `${SITE}/${path}` });
  } catch (err) {
    console.error('blog-cms POST /image:', err);
    res.status(500).json({ error: 'Не удалось загрузить картинку' });
  }
});

router.get('/build-status', requireAdmin, ghReady, async (req, res) => {
  try {
    const { data } = await octokit.repos.getPagesBuild({ owner: OWNER, repo: REPO, build_id: 'latest' }).catch(() => ({ data: null }));
    if (!data) return res.json({ status: 'unknown' });
    res.json({ status: data.status, updatedAt: data.updated_at, error: data.error && data.error.message });
  } catch (err) {
    res.json({ status: 'unknown' });
  }
});

module.exports = router;
