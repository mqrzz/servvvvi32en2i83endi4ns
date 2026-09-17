const express = require('express');
const { Octokit } = require('@octokit/rest');
const { requireAdmin } = require('../middleware/requireAuth');

const router = express.Router();

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

// ── Разделы блога, которые устроены как «статья на файл» ──
// (Обновления — отдельная система, таймлайн на одной странице, см. ниже)
const SECTIONS = {
  articles: { dir: 'articles', index: 'articles/index.html', cardClass: 'a-card', homeSync: true },
  news: { dir: 'news', index: 'news/index.html', cardClass: 'news-card', homeSync: false },
};
function sectionMw(req, res, next) {
  const s = SECTIONS[req.params.section];
  if (!s) return res.status(404).json({ error: 'Неизвестный раздел' });
  req.section = s;
  next();
}

const HOME_INDEX = 'index.html';
const SITEMAP_PATH = 'sitemap.xml';
const FEED_PATH = 'feed.xml';
const UPDATES_PATH = 'updates/index.html';
const HOME_CARDS_LIMIT = 6;
const UPDATES_LIMIT = 3;

// Границы «редактируемого тела» — от подключения nav до подключения footer-скрипта.
// Единая граница подходит и для articles/, и для news/ (кнопка «наверх» есть не везде).
const NAV_SCRIPT_RE = /<script src="https:\/\/blog\.antviz\.ru\/blog-nav\.js" data-page="[^"]*"><\/script>/;
const FOOTER_SCRIPT_RE = /<script src="https:\/\/blog\.antviz\.ru\/blog-footer\.js"[^>]*><\/script>/;

// ── Библиотека иконок для карточек — взяты из существующего дизайна ──
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
// Иконки для пунктов таймлайна обновлений — фиксированные, по типу (add/fix/change), не выбираются вручную.
const KIND_ICONS = {
  add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>',
  fix: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>',
  change: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><path d="m7.5 4.27 9 5.15"/></svg>',
};
const TL_DOT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

router.get('/icons', requireAdmin, (req, res) => {
  res.json(Object.keys(ICONS).map((key) => ({ key, svg: ICON_SVG_WRAP(ICONS[key]) })));
});

function slugify(s) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'i',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return String(s || '').toLowerCase().split('').map((ch) => map[ch] !== undefined ? map[ch] : ch).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'stranica';
}
function escHtml(s) { return String(s || '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escAttr(s) { return escHtml(s).replace(/\n/g, ' '); }
function escJson(s) { return JSON.stringify(String(s || '')).slice(1, -1); }
function rfc822Date(iso) { const d = new Date(iso + 'T12:00:00+03:00'); return d.toUTCString().replace('GMT', '+0300'); }
function ruDate(iso) {
  const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
  const d = new Date(iso + 'T12:00:00');
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}
function readingTimeMinutes(html) {
  const words = String(html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

// ────────────────────────────────────────────────────────────────
// Статьи/новости: голова патчится точечно, тело — сырой HTML как есть.
// ────────────────────────────────────────────────────────────────
function splitArticle(html) {
  const navMatch = html.match(NAV_SCRIPT_RE);
  const footerMatch = html.match(FOOTER_SCRIPT_RE);
  if (!navMatch || !footerMatch) return null;
  const bodyStart = navMatch.index + navMatch[0].length;
  const endIdx = footerMatch.index;
  if (endIdx <= bodyStart) return null;
  return { head: html.slice(0, bodyStart), body: html.slice(bodyStart, endIdx), tail: html.slice(endIdx) };
}
function extractMeta(html) {
  const get = (re) => { const m = html.match(re); return m ? m[1] : ''; };
  const cmsMetaRaw = get(/<!-- cms-meta: ([A-Za-z0-9+/=]+) -->/);
  let cmsMeta = {};
  if (cmsMetaRaw) { try { cmsMeta = JSON.parse(Buffer.from(cmsMetaRaw, 'base64').toString('utf-8')); } catch (e) { /* игнорируем битый комментарий, не роняем парсинг */ } }
  return {
    title: get(/<title>([\s\S]*?)<\/title>/),
    description: get(/<meta name="description" content="([^"]*)"/),
    ogImage: get(/<meta property="og:image" content="([^"]*)"/),
    category: get(/<meta property="article:section" content="([^"]*)"/),
    publishedTime: get(/<meta property="article:published_time" content="([^"]*)"/).slice(0, 10),
    excerpt: cmsMeta.excerpt || '',
    icon: cmsMeta.icon || '',
  };
}
// Экскерпт и иконка нигде в стандартных SEO-тегах не живут (это не часть
// HTML-спеки), а нужны и для черновиков (у которых карточки ещё нет вообще).
// Храним их в служебном HTML-комментарии — невидим на странице, переживает
// любое число сохранений, что бы ни делали с публикацией/черновиком.
function upsertCmsMetaComment(head, excerpt, icon) {
  const json = JSON.stringify({ excerpt: excerpt || '', icon: icon || 'grid' });
  const b64 = Buffer.from(json, 'utf-8').toString('base64');
  const tag = `<!-- cms-meta: ${b64} -->`;
  if (/<!-- cms-meta: [A-Za-z0-9+/=]+ -->/.test(head)) return head.replace(/<!-- cms-meta: [A-Za-z0-9+/=]+ -->/, tag);
  return head.replace('</title>', '</title>\n  ' + tag);
}
function patchHead(head, f) {
  const isoDate = f.publishedDate;
  const isoTime = `${isoDate}T12:00:00+03:00`;
  const url = `${SITE}/${f.section}/${f.slug}`;
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
  out = upsertCmsMetaComment(out, f.excerpt, f.icon);
  return out;
}
function buildArticleHtml({ f, body, tail, head }) { return patchHead(head, f) + body + tail; }

async function cloneSkeleton(section, cloneSlug) {
  const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: `${SECTIONS[section].dir}/${cloneSlug}.html`, ref: BRANCH });
  const html = Buffer.from(data.content, 'base64').toString('utf-8');
  const split = splitArticle(html);
  if (!split) throw new Error('Не удалось разобрать структуру исходного файла для клонирования');
  return { ...split, oldMeta: extractMeta(html) };
}

function buildIndexCard(f) {
  return `      <a href="${f.slug}" class="${f.cardClass} reveal">
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
  if (re.test(html)) return html.replace(re, '\n' + newCardBlock);
  const firstCardRe = new RegExp(`([ \\t]*)<a href="[^"]*"[^>]*class="${cls}[^"]*"`);
  const m = html.match(firstCardRe);
  if (!m) return html;
  return html.slice(0, m.index) + newCardBlock + '\n\n' + html.slice(m.index);
}
function removeCard(html, slug, cls) { return html.replace(cardRegexFor(slug, cls), ''); }
function capHomeCards(html, limit) {
  const re = /<a href="articles\/[^"]*"[^>]*class="news-card[^"]*"[\s\S]*?<\/a>/g;
  const matches = [...html.matchAll(re)];
  if (matches.length <= limit) return html;
  for (const m of matches.slice(limit)) html = html.replace(m[0], '');
  return html;
}

function upsertSitemap(xml, section, slug) {
  const url = `${SITE}/${section}/${slug}`;
  if (xml.includes(`<loc>${url}</loc>`)) return xml;
  const entry = `  <url>\n    <loc>${url}</loc>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
  return xml.replace('</urlset>', entry + '</urlset>');
}
function removeSitemap(xml, section, slug) {
  const url = `${SITE}/${section}/${slug}`;
  const re = new RegExp(`\\s*<url>\\s*<loc>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/loc>[\\s\\S]*?<\\/url>`);
  return xml.replace(re, '');
}
function upsertFeed(xml, section, f) {
  const url = `${SITE}/${section}/${f.slug}`;
  const entry = `  <item>\n    <title>${escHtml(f.title)}</title>\n    <link>${url}</link>\n    <guid>${url}</guid>\n    <pubDate>${rfc822Date(f.publishedDate)}</pubDate>\n    <description>${escHtml(f.excerpt)}</description>\n  </item>\n`;
  const re = new RegExp(`\\s*<item>\\s*<title>[\\s\\S]*?<link>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/link>[\\s\\S]*?<\\/item>`);
  let out = xml.replace(re, '');
  const firstItem = out.indexOf('<item>');
  if (firstItem === -1) return out.replace('</channel>', entry + '</channel>');
  return out.slice(0, firstItem) + entry + '\n' + out.slice(firstItem);
}
function removeFeed(xml, section, slug) {
  const url = `${SITE}/${section}/${slug}`;
  const re = new RegExp(`\\s*<item>\\s*<title>[\\s\\S]*?<link>${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/link>[\\s\\S]*?<\\/item>`);
  return xml.replace(re, '');
}
function insertNoindex(html) {
  if (/<meta name="robots"/.test(html)) return html;
  return html.replace('</title>', '</title>\n  <meta name="robots" content="noindex" />');
}
function removeNoindex(html) { return html.replace(/\s*<meta name="robots" content="noindex"\s*\/?>/, ''); }

// ────────────────────────────────────────────────────────────────
// Git: чтение файла + атомарный коммит нескольких файлов разом
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
// Автопубликация черновиков по дате — вызывается по расписанию из server.js
// (см. utils/blogAutoPublish.js). Черновик с датой публикации в прошлом или
// сегодня публикуется сам, без захода в админку.
// ────────────────────────────────────────────────────────────────
async function publishDraftNow(section, slug) {
  const html = await getFile(`${SECTIONS[section].dir}/${slug}.html`);
  if (!html || !/<meta name="robots" content="noindex"/.test(html)) return; // уже не черновик или не найден
  const split = splitArticle(html);
  if (!split) return;
  const meta = extractMeta(html);
  const cleanTitle = meta.title.replace(/\s*\|\s*Блог Antviz\s*$/, '');
  const f = {
    slug, section, title: cleanTitle, description: meta.description, category: meta.category,
    ogImage: meta.ogImage, publishedDate: meta.publishedTime, cardTitle: cleanTitle,
    excerpt: meta.excerpt || '', icon: meta.icon || 'grid', readingTime: readingTimeMinutes(split.body),
    cardClass: SECTIONS[section].cardClass,
  };
  const articleHtml = removeNoindex(html);
  const commitPayload = { [`${SECTIONS[section].dir}/${slug}.html`]: articleHtml };
  const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
    getFile(SECTIONS[section].index), SECTIONS[section].homeSync ? getFile(HOME_INDEX) : null, getFile(SITEMAP_PATH), getFile(FEED_PATH),
  ]);
  if (indexHtml) commitPayload[SECTIONS[section].index] = upsertCard(indexHtml, slug, SECTIONS[section].cardClass, buildIndexCard(f));
  if (SECTIONS[section].homeSync && homeHtml) commitPayload[HOME_INDEX] = capHomeCards(upsertCard(homeHtml, slug, 'news-card', buildHomeCard(f)), HOME_CARDS_LIMIT);
  if (sitemapXml) commitPayload[SITEMAP_PATH] = upsertSitemap(sitemapXml, section, slug);
  if (feedXml) commitPayload[FEED_PATH] = upsertFeed(feedXml, section, f);
  await commitFiles(commitPayload, `Блог: автопубликация «${f.title}»`);
  delete listCache[section];
}

async function checkAndPublishDueDrafts() {
  if (!process.env.GITHUB_TOKEN || !OWNER || !REPO) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const section of Object.keys(SECTIONS)) {
    try {
      const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: SECTIONS[section].dir, ref: BRANCH });
      const files = data.filter((f) => f.type === 'file' && f.name.endsWith('.html') && f.name !== 'index.html');
      for (const file of files) {
        const html = await getFile(file.path);
        if (!html || !/<meta name="robots" content="noindex"/.test(html)) continue;
        const meta = extractMeta(html);
        if (!meta.publishedTime || meta.publishedTime > today) continue;
        const slug = file.name.replace(/\.html$/, '');
        await publishDraftNow(section, slug);
        console.log(`blog-cms: автопубликация по расписанию — ${section}/${slug}`);
      }
    } catch (err) {
      console.error(`blog-cms checkAndPublishDueDrafts (${section}):`, err.message);
    }
  }
}

// ────────────────────────────────────────────────────────────────
// ОБНОВЛЕНИЯ (updates/index.html) — таймлайн версий, не файлы-статьи
// ────────────────────────────────────────────────────────────────
function parseUpdates(html) {
  const items = [...html.matchAll(/<div class="tl-item( major)?[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/g)];
  // ^ жадный вложенный div сложно ловить регуляркой надёжно — парсим по частям ниже, это только для подсчёта позиций
  const blocks = [];
  const re = /<div class="tl-item( major)?\s*reveal">[\s\S]*?<div class="tl-card">\s*<div class="tl-head">([\s\S]*?)<\/div>\s*<ul class="tl-list">([\s\S]*?)<\/ul>\s*<\/div>\s*<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const [full, majorFlag, head, listHtml] = m;
    const version = (head.match(/tl-version">([^<]*)</) || [])[1] || '';
    const dateText = (head.match(/tl-date">([^<]*)</) || [])[1] || '';
    const fresh = /tl-badge fresh/.test(head);
    const liItems = [...listHtml.matchAll(/<li><span class="kind (\w+)">[\s\S]*?<\/span><span><b>([^<]*)<\/b>\s*([\s\S]*?)<\/span><\/li>/g)]
      .map((lm) => ({ kind: lm[1], title: lm[2], description: lm[3].trim() }));
    blocks.push({ version, dateText, major: !!majorFlag, fresh, items: liItems, raw: full, index: m.index });
  }
  return blocks;
}
function buildTlItem(entry) {
  const itemsHtml = entry.items.map((it) => `              <li><span class="kind ${it.kind}">${KIND_ICONS[it.kind] || KIND_ICONS.add}</span><span><b>${escHtml(it.title)}.</b> ${escHtml(it.description)}</span></li>`).join('\n');
  return `        <div class="tl-item${entry.major ? ' major' : ''} reveal">
          <div class="tl-dot">
            ${TL_DOT_ICON}
          </div>
          <div class="tl-card">
            <div class="tl-head">
              <span class="tl-version">${escHtml(entry.version)}</span>
              <span class="tl-date">${ruDate(entry.date)}</span>
              ${entry.fresh ? '<span class="tl-badge fresh">Свежее</span>' : ''}
            </div>
            <ul class="tl-list">
${itemsHtml}
            </ul>
          </div>
        </div>`;
}
function updateHomePreview(homeHtml, entry) {
  const first = entry.items[0];
  const summaryBold = first ? escHtml(first.title) : escHtml(entry.version);
  const summaryRest = entry.items.slice(1, 3).map((it) => escHtml(it.title.replace(/\.$/, '').toLowerCase())).join(', ');
  const block = `<a href="updates" class="update-preview reveal">
      <div class="v">
        <span class="v-num">${escHtml(entry.version)}</span>
        <span class="v-badge">Свежее</span>
      </div>
      <div class="v-text"><b>${summaryBold}</b>${summaryRest ? ', ' + summaryRest : ''}.</div>
      <div class="read">Подробнее <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></div>
    </a>`;
  return homeHtml.replace(/<a href="updates" class="update-preview[^"]*"[\s\S]*?<\/a>/, block);
}

router.get('/updates/list', requireAdmin, ghReady, async (req, res) => {
  try {
    const html = await getFile(UPDATES_PATH);
    if (!html) return res.status(404).json({ error: 'Файл обновлений не найден' });
    const entries = parseUpdates(html).map((e) => ({
      version: e.version, date: e.dateText, major: e.major, fresh: e.fresh, items: e.items,
    }));
    res.json(entries);
  } catch (err) {
    console.error('blog-cms GET /updates/list:', err);
    res.status(500).json({ error: 'Не удалось получить список обновлений' });
  }
});

function validateUpdate(b) {
  if (!b.version || !b.version.trim()) return 'Укажите версию';
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return 'Укажите дату';
  if (!Array.isArray(b.items) || !b.items.length) return 'Добавьте хотя бы один пункт';
  for (const it of b.items) {
    if (!['add', 'fix', 'change'].includes(it.kind)) return 'Некорректный тип пункта';
    if (!it.title || !it.title.trim()) return 'У каждого пункта должен быть заголовок';
  }
  return null;
}

// ── POST /api/blog-cms/updates ── новая запись в таймлайн ──
// Собирает итоговый updates/index.html: новая запись первой, существующие —
// без бейджа fresh, всего не больше UPDATES_LIMIT записей. Работает по точным
// смещениям из parseUpdates (а не повторным regex), поэтому не может случайно
// зацепить два блока разом.
function applyNewUpdateEntry(html, entries, newEntry) {
  const newBlock = buildTlItem({ ...newEntry, fresh: true });
  if (!entries.length) {
    // файл вообще без записей (не должно случаться в реальности, но не падаем)
    const insertAt = html.indexOf('<div class="tl"');
    return insertAt === -1 ? html : html.slice(0, insertAt) + newBlock + '\n\n' + html.slice(insertAt);
  }
  const prefix = html.slice(0, entries[0].index);
  const lastEntry = entries[entries.length - 1];
  const suffix = html.slice(lastEntry.index + lastEntry.raw.length);
  const keptExisting = entries.slice(0, UPDATES_LIMIT - 1).map((e) => e.raw.replace(/\s*<span class="tl-badge fresh">Свежее<\/span>/, ''));
  const middle = [newBlock, ...keptExisting].join('\n\n');
  return prefix + middle + '\n\n' + suffix;
}

router.post('/updates', requireAdmin, ghReady, async (req, res) => {
  const b = req.body || {};
  const err = validateUpdate(b);
  if (err) return res.status(400).json({ error: err });
  try {
    const html = await getFile(UPDATES_PATH);
    if (!html) return res.status(500).json({ error: 'Файл обновлений не найден' });
    const entries = parseUpdates(html);
    if (entries.some((e) => e.version === b.version.trim())) return res.status(409).json({ error: 'Такая версия уже есть' });

    const newEntry = { version: b.version.trim(), date: b.date, major: !!b.major, items: b.items };
    const html2 = applyNewUpdateEntry(html, entries, newEntry);

    const homeHtml = await getFile(HOME_INDEX);
    const commitPayload = { [UPDATES_PATH]: html2 };
    if (homeHtml) commitPayload[HOME_INDEX] = updateHomePreview(homeHtml, newEntry);

    await commitFiles(commitPayload, `Блог: новая запись в обновлениях ${newEntry.version}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('blog-cms POST /updates:', err);
    res.status(500).json({ error: 'Не удалось сохранить: ' + err.message });
  }
});

// ── DELETE /api/blog-cms/updates/:version ──
router.delete('/updates/:version', requireAdmin, ghReady, async (req, res) => {
  try {
    const html = await getFile(UPDATES_PATH);
    if (!html) return res.status(404).json({ error: 'Не найдено' });
    const entries = parseUpdates(html);
    const target = entries.find((e) => e.version === req.params.version);
    if (!target) return res.status(404).json({ error: 'Версия не найдена' });
    const html2 = html.replace(target.raw, '');
    await commitFiles({ [UPDATES_PATH]: html2 }, `Блог: удалена запись ${req.params.version}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('blog-cms DELETE /updates/:version:', err);
    res.status(500).json({ error: 'Не удалось удалить: ' + err.message });
  }
});

// ── POST /api/blog-cms/image ──
router.post('/image', requireAdmin, ghReady, async (req, res) => {
  const { fileName, base64, folder } = req.body || {};
  if (!fileName || !base64 || base64.length < 10) return res.status(400).json({ error: 'Некорректные данные файла' });
  const safeName = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  const dir = `img/${(folder || 'og').replace(/[^a-z0-9-]/g, '')}`;
  const path = `${dir}/${Date.now()}-${safeName}`;
  try {
    const match = /^data:([^;]+);base64,(.+)$/.exec(base64);
    const content = match ? match[2] : base64;
    await octokit.repos.createOrUpdateFileContents({ owner: OWNER, repo: REPO, path, message: `Блог: загружена картинка ${safeName}`, content, branch: BRANCH });
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

// ────────────────────────────────────────────────────────────────
// РОУТЫ: /:section (articles | news)
// ────────────────────────────────────────────────────────────────
const listCache = {};
router.get('/:section', requireAdmin, ghReady, sectionMw, async (req, res) => {
  try {
    const cacheKey = req.params.section;
    if (listCache[cacheKey] && Date.now() - listCache[cacheKey].at < 30_000) return res.json(listCache[cacheKey].data);
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: req.section.dir, ref: BRANCH });
    const files = data.filter((f) => f.type === 'file' && f.name.endsWith('.html') && f.name !== 'index.html');
    const items = await Promise.all(files.map(async (f) => {
      const slug = f.name.replace(/\.html$/, '');
      const html = await getFile(f.path);
      const meta = extractMeta(html);
      const draft = /<meta name="robots" content="noindex"/.test(html);
      return {
        slug, title: meta.title.replace(/\s*\|\s*Блог Antviz\s*$/, ''), description: meta.description,
        category: meta.category, ogImage: meta.ogImage, publishedDate: meta.publishedTime, draft,
      };
    }));
    items.sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || ''));
    listCache[cacheKey] = { at: Date.now(), data: items };
    res.json(items);
  } catch (err) {
    console.error('blog-cms GET /:section:', err);
    res.status(500).json({ error: 'Не удалось получить список' });
  }
});

router.get('/:section/for-clone', requireAdmin, ghReady, sectionMw, async (req, res) => {
  try {
    const { data } = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: req.section.dir, ref: BRANCH });
    const files = data.filter((f) => f.type === 'file' && f.name.endsWith('.html') && f.name !== 'index.html');
    res.json(files.map((f) => ({ slug: f.name.replace(/\.html$/, ''), title: f.name })));
  } catch (err) {
    res.status(500).json({ error: 'Не удалось получить список' });
  }
});

router.get('/:section/:slug', requireAdmin, ghReady, sectionMw, async (req, res) => {
  try {
    const html = await getFile(`${req.section.dir}/${req.params.slug}.html`);
    if (!html) return res.status(404).json({ error: 'Не найдено' });
    const split = splitArticle(html);
    if (!split) return res.status(500).json({ error: 'Не удалось разобрать структуру файла' });
    const meta = extractMeta(html);
    const draft = /<meta name="robots" content="noindex"/.test(html);
    // excerpt/icon для старых статей (сохранённых до появления cms-meta-комментария)
    // подстрахуем из уже существующей карточки — новые всегда берут их из комментария.
    let excerpt = meta.excerpt, icon = meta.icon;
    if (!excerpt || !icon) {
      const indexHtml = await getFile(req.section.index);
      const cardMatch = indexHtml && indexHtml.match(cardRegexFor(req.params.slug, req.section.cardClass));
      if (cardMatch) {
        const excerptMatch = cardMatch[0].match(/<p>([\s\S]*?)<\/p>/);
        if (!excerpt && excerptMatch) excerpt = excerptMatch[1];
      }
    }
    res.json({
      slug: req.params.slug, title: meta.title.replace(/\s*\|\s*Блог Antviz\s*$/, ''), description: meta.description,
      category: meta.category, ogImage: meta.ogImage, publishedDate: meta.publishedTime,
      excerpt: excerpt || '', icon: icon || 'grid', draft, bodyHtml: split.body, readingTime: readingTimeMinutes(split.body),
    });
  } catch (err) {
    console.error('blog-cms GET /:section/:slug:', err);
    res.status(500).json({ error: 'Не удалось загрузить' });
  }
});

function validateFields(b) {
  if (!b.title || !b.title.trim()) return 'Укажите заголовок';
  if (!b.category || !b.category.trim()) return 'Укажите категорию';
  if (!b.publishedDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.publishedDate)) return 'Укажите дату публикации';
  if (!b.bodyHtml || !b.bodyHtml.trim()) return 'Тело не может быть пустым';
  return null;
}

router.post('/:section', requireAdmin, ghReady, sectionMw, async (req, res) => {
  const b = req.body || {};
  const err = validateFields(b);
  if (err) return res.status(400).json({ error: err });
  if (!b.cloneFrom) return res.status(400).json({ error: 'Укажите каркас для клонирования' });
  const section = req.params.section;
  try {
    const slug = slugify(b.slug || b.title);
    if (await getFile(`${req.section.dir}/${slug}.html`)) return res.status(409).json({ error: 'Материал с таким адресом уже существует' });

    const skeleton = await cloneSkeleton(section, b.cloneFrom);
    const f = {
      slug, section, title: b.title.trim(), description: (b.description || '').trim(), category: b.category.trim(),
      ogImage: b.ogImage || '', publishedDate: b.publishedDate, cardTitle: b.title.trim(),
      excerpt: (b.excerpt || '').trim(), icon: b.icon || 'grid', readingTime: readingTimeMinutes(b.bodyHtml),
      cardClass: req.section.cardClass,
    };
    let body = b.bodyHtml;
    if (skeleton.oldMeta.title) body = body.split(skeleton.oldMeta.title.replace(/\s*\|\s*Блог Antviz\s*$/, '')).join(f.title);
    if (skeleton.oldMeta.category) body = body.split(skeleton.oldMeta.category).join(f.category);

    let articleHtml = buildArticleHtml({ f, body, tail: skeleton.tail, head: skeleton.head });
    if (b.draft) articleHtml = insertNoindex(articleHtml);

    const commitPayload = { [`${req.section.dir}/${slug}.html`]: articleHtml };
    if (!b.draft) {
      const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
        getFile(req.section.index), req.section.homeSync ? getFile(HOME_INDEX) : null, getFile(SITEMAP_PATH), getFile(FEED_PATH),
      ]);
      if (indexHtml) commitPayload[req.section.index] = upsertCard(indexHtml, slug, req.section.cardClass, buildIndexCard(f));
      if (req.section.homeSync && homeHtml) commitPayload[HOME_INDEX] = capHomeCards(upsertCard(homeHtml, slug, 'news-card', buildHomeCard(f)), HOME_CARDS_LIMIT);
      if (sitemapXml) commitPayload[SITEMAP_PATH] = upsertSitemap(sitemapXml, section, slug);
      if (feedXml) commitPayload[FEED_PATH] = upsertFeed(feedXml, section, f);
    }
    await commitFiles(commitPayload, `Блог: новый материал «${f.title}» (${section})`);
    delete listCache[section];
    res.json({ ok: true, slug });
  } catch (err) {
    console.error('blog-cms POST /:section:', err);
    res.status(500).json({ error: 'Не удалось создать: ' + err.message });
  }
});

router.put('/:section/:slug', requireAdmin, ghReady, sectionMw, async (req, res) => {
  const b = req.body || {};
  const err = validateFields(b);
  if (err) return res.status(400).json({ error: err });
  const section = req.params.section;
  const slug = req.params.slug;
  try {
    const html = await getFile(`${req.section.dir}/${slug}.html`);
    if (!html) return res.status(404).json({ error: 'Не найдено' });
    const split = splitArticle(html);
    if (!split) return res.status(500).json({ error: 'Не удалось разобрать структуру файла' });

    const f = {
      slug, section, title: b.title.trim(), description: (b.description || '').trim(), category: b.category.trim(),
      ogImage: b.ogImage || '', publishedDate: b.publishedDate, cardTitle: b.title.trim(),
      excerpt: (b.excerpt || '').trim(), icon: b.icon || 'grid', readingTime: readingTimeMinutes(b.bodyHtml),
      cardClass: req.section.cardClass,
    };
    let articleHtml = buildArticleHtml({ f, body: b.bodyHtml, tail: split.tail, head: split.head });
    const nowDraft = !!b.draft;
    articleHtml = nowDraft ? insertNoindex(articleHtml) : removeNoindex(articleHtml);

    const commitPayload = { [`${req.section.dir}/${slug}.html`]: articleHtml };
    const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
      getFile(req.section.index), req.section.homeSync ? getFile(HOME_INDEX) : null, getFile(SITEMAP_PATH), getFile(FEED_PATH),
    ]);
    if (nowDraft) {
      if (indexHtml) commitPayload[req.section.index] = removeCard(indexHtml, slug, req.section.cardClass);
      if (req.section.homeSync && homeHtml) commitPayload[HOME_INDEX] = removeCard(homeHtml, slug, 'news-card');
      if (sitemapXml) commitPayload[SITEMAP_PATH] = removeSitemap(sitemapXml, section, slug);
      if (feedXml) commitPayload[FEED_PATH] = removeFeed(feedXml, section, slug);
    } else {
      if (indexHtml) commitPayload[req.section.index] = upsertCard(indexHtml, slug, req.section.cardClass, buildIndexCard(f));
      if (req.section.homeSync && homeHtml) commitPayload[HOME_INDEX] = capHomeCards(upsertCard(homeHtml, slug, 'news-card', buildHomeCard(f)), HOME_CARDS_LIMIT);
      if (sitemapXml) commitPayload[SITEMAP_PATH] = upsertSitemap(sitemapXml, section, slug);
      if (feedXml) commitPayload[FEED_PATH] = upsertFeed(feedXml, section, f);
    }
    await commitFiles(commitPayload, `Блог: правки «${f.title}» (${section})`);
    delete listCache[section];
    res.json({ ok: true, slug });
  } catch (err) {
    console.error('blog-cms PUT /:section/:slug:', err);
    res.status(500).json({ error: 'Не удалось сохранить: ' + err.message });
  }
});

router.delete('/:section/:slug', requireAdmin, ghReady, sectionMw, async (req, res) => {
  const section = req.params.section;
  const slug = req.params.slug;
  try {
    if (!(await getFile(`${req.section.dir}/${slug}.html`))) return res.status(404).json({ error: 'Не найдено' });
    const [indexHtml, homeHtml, sitemapXml, feedXml] = await Promise.all([
      getFile(req.section.index), req.section.homeSync ? getFile(HOME_INDEX) : null, getFile(SITEMAP_PATH), getFile(FEED_PATH),
    ]);
    const commitPayload = { [`${req.section.dir}/${slug}.html`]: null };
    if (indexHtml) commitPayload[req.section.index] = removeCard(indexHtml, slug, req.section.cardClass);
    if (req.section.homeSync && homeHtml) commitPayload[HOME_INDEX] = removeCard(homeHtml, slug, 'news-card');
    if (sitemapXml) commitPayload[SITEMAP_PATH] = removeSitemap(sitemapXml, section, slug);
    if (feedXml) commitPayload[FEED_PATH] = removeFeed(feedXml, section, slug);
    await commitFiles(commitPayload, `Блог: удалено «${slug}» (${section})`);
    delete listCache[section];
    res.json({ ok: true });
  } catch (err) {
    console.error('blog-cms DELETE /:section/:slug:', err);
    res.status(500).json({ error: 'Не удалось удалить: ' + err.message });
  }
});


module.exports = router;
module.exports.checkAndPublishDueDrafts = checkAndPublishDueDrafts;
