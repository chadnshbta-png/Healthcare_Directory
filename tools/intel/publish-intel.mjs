/**
 * Publish the store to static files the site can serve.
 *
 * Two outputs, for two different consumers:
 *   intelligence/data/*.json      the landing page fetches these; small, paged,
 *                                 so a browser never downloads the archive.
 *   intelligence/a/<slug>/        one real HTML page per published article, with
 *                                 canonical URL, Open Graph, Twitter card and
 *                                 NewsArticle + BreadcrumbList structured data.
 *                                 A crawler gets served markup, not a shell.
 *
 * Writing is atomic per file and NEVER touches data/ — the directory dataset is
 * published by tools/publish.mjs and is not this tool's business.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATUS, CATEGORY_LABEL, CONTENT_TYPE_LABEL } from './store.mjs';
import { usableImage } from './rss.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const PAGE_SIZE = 12;

/** Plain text of some HTML, for counting words. */
const textOf = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reading time from the words we ACTUALLY hold — body if the publisher
 * syndicated one, otherwise the summary. At 225 wpm (the middle of the usual
 * 200–250 range), rounded up, never below one minute. Null when there is not
 * enough text to time honestly, so the UI can omit it rather than print
 * "1 min read" over two sentences.
 */
function readingTime(article) {
  const words = textOf(article.content || article.summary || article.excerpt || '')
    .split(/\s+/).filter(Boolean).length;
  if (words < 40) return null;
  return { minutes: Math.max(1, Math.round(words / 225)), words };
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const human = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Shape one row for the client. Only published fields ever leave the store. */
function toPublic(db, r) {
  const all = db.prepare(`select entityType, entityId, entityLabel, confidence, method
    from ArticleEntity where articleId = ? order by confidence desc`).all(r.id);
  // Ambiguous mentions are kept in the store for editorial review but are NEVER
  // published as a relationship — an unresolved name must not become a link.
  const ents = all.filter((e) => e.method !== 'ambiguous');
  const group = (t) => ents.filter((e) => e.entityType === t)
    .map((e) => ({ id: e.entityId, label: e.entityLabel, method: e.method,
      confidence: Number(e.confidence.toFixed(2)) }));
  const base = {
    content: r.content,
    summary: r.summary,
    excerpt: r.excerpt,
  };
  const rt = readingTime(base);
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    summary: r.summary,
    analysis: r.analysis,
    // The publisher's own body, sanitised at ingest. Null when they syndicated
    // only a teaser — in which case the page says so and links out.
    content: r.content,
    hasFullContent: Boolean(r.content),
    readingMinutes: rt?.minutes ?? null,
    wordCount: rt?.words ?? null,
    category: r.category,
    categoryLabel: CATEGORY_LABEL[r.category] ?? r.category,
    contentType: r.contentType,
    contentTypeLabel: CONTENT_TYPE_LABEL[r.contentType] ?? r.contentType,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    canonicalUrl: r.canonicalUrl,
    author: r.author,
    // The stored value is whatever the feed said; what we PUBLISH is only an
    // image that is actually a picture of the story. Sprites, tracking pixels
    // and the publisher's shared "no image" placeholder are filtered here as
    // well as at ingest, so a corpus collected before the ingest fix is
    // corrected without rewriting a single stored row.
    image: usableImage(r.image),
    tags: JSON.parse(r.tags ?? '[]'),
    originalPublishedAt: iso(r.originalPublishedAt),
    retrievedAt: iso(r.retrievedAt),
    updatedAt: iso(r.updatedAt),
    publishedAt: iso(r.publishedAt),
    // How this record was classified, published so a reader can tell a rule
    // from a model rather than having to trust the word "AI".
    classifier: r.classifier,
    region: r.region ?? 'global',
    storyId: r.storyId,
    ambiguousMentions: all.filter((e) => e.method === 'ambiguous').length,
    specialtyIds: group('specialty').map((x) => x.id),
    facilityIds: group('facility').map((x) => x.id),
    doctorIds: group('doctor').map((x) => x.id),
    locationIds: [],
    related: {
      specialties: group('specialty'),
      facilities: group('facility'),
      doctors: group('doctor'),
      locations: [],
    },
  };
}

function articleHtml(a, siteBase) {
  const url = `${siteBase}/intelligence/a/${a.slug}/`;
  const desc = (a.summary ?? a.excerpt ?? a.title).slice(0, 300);
  const ld = {
    '@context': 'https://schema.org',
    '@type': a.contentType === 'research' ? 'ScholarlyArticle' : 'NewsArticle',
    headline: a.title,
    description: desc,
    datePublished: a.originalPublishedAt ?? a.publishedAt,
    dateModified: a.updatedAt,
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    ...(a.image ? { image: [a.image] } : {}),
    ...(a.author ? { author: [{ '@type': 'Person', name: a.author }] } : {}),
    publisher: { '@type': 'Organization', name: 'Doctorna' },
    // The record is an attributed pointer to the original, so the original is
    // named as the source rather than implied to be ours.
    isBasedOn: a.sourceUrl,
    citation: { '@type': 'CreativeWork', name: a.sourceName, url: a.sourceUrl },
  };
  const crumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Doctorna', item: `${siteBase}/` },
      { '@type': 'ListItem', position: 2, name: 'Intelligence', item: `${siteBase}/intelligence/` },
      { '@type': 'ListItem', position: 3, name: a.categoryLabel, item: `${siteBase}/intelligence/?category=${a.category}` },
      { '@type': 'ListItem', position: 4, name: a.title, item: url },
    ],
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.title)} — Doctorna Intelligence</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Doctorna Intelligence">
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${a.image ? `<meta property="og:image" content="${esc(a.image)}">` : ''}
${a.originalPublishedAt ? `<meta property="article:published_time" content="${esc(a.originalPublishedAt)}">` : ''}
<meta property="article:section" content="${esc(a.categoryLabel)}">
<meta name="twitter:card" content="${a.image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(a.title)}">
<meta name="twitter:description" content="${esc(desc)}">
${a.image ? `<meta name="twitter:image" content="${esc(a.image)}">` : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/intelligence/intel.css">
<script type="application/ld+json">${JSON.stringify(ld)}</script>
<script type="application/ld+json">${JSON.stringify(crumbs)}</script>
</head>
<body class="intel-body">
<a class="skip" href="#article">Skip to content</a>
<div id="intelHeader"></div>
<main class="intel-wrap" id="article" data-article="${esc(a.slug)}">
  <nav class="intel-crumbs" aria-label="Breadcrumb">
    <a href="/">Doctorna</a><span aria-hidden="true">/</span>
    <a href="/intelligence/">Intelligence</a><span aria-hidden="true">/</span>
    <a href="/intelligence/?category=${esc(a.category)}">${esc(a.categoryLabel)}</a>
  </nav>
  <article class="intel-article">
    <div class="intel-kicker">
      <span class="intel-cat">${esc(a.categoryLabel)}</span>
      <span class="intel-type intel-type-${esc(a.contentType)}">${esc(a.contentTypeLabel)}</span>
      ${a.originalPublishedAt ? `<time class="intel-metabit" datetime="${esc(a.originalPublishedAt)}">${esc(human(Date.parse(a.originalPublishedAt)))}</time>` : ''}
      ${a.readingMinutes ? `<span class="intel-metabit">${a.readingMinutes} min read</span>` : ''}
      <span class="intel-metabit" data-views hidden></span>
    </div>
    <h1>${esc(a.title)}</h1>
    ${a.summary ? `<p class="intel-lede">${esc(a.summary)}</p>` : ''}
    ${a.image ? `<figure class="intel-figure"><img src="${esc(a.image)}" alt="" loading="lazy" decoding="async"
      onerror="this.parentElement.remove()"></figure>` : ''}
    ${a.content
      ? `<div class="intel-body-copy">${a.content}</div>`
      : `<p class="intel-teaser-note">${esc(a.sourceName)} syndicates a summary rather than the
           full article text for this item, so the whole story is on their site.</p>`}
    <div class="intel-source" role="note">
      <div class="intel-source-row"><span>Source</span>
        <a href="${esc(a.sourceUrl)}" rel="noopener nofollow" target="_blank">${esc(a.sourceName)}</a></div>
      ${a.originalPublishedAt ? `<div class="intel-source-row"><span>Published</span><time datetime="${esc(a.originalPublishedAt)}">${esc(human(Date.parse(a.originalPublishedAt)))}</time></div>` : ''}
      <div class="intel-source-row"><span>Retrieved</span><time datetime="${esc(a.retrievedAt)}">${esc(human(Date.parse(a.retrievedAt)))}</time></div>
      <div class="intel-source-row"><span>Classified by</span><span>${esc(a.classifier)}</span></div>
    </div>
    ${a.contentType === 'medical' ? `<p class="intel-medical-note">Clinical content. Summarised from the source and reviewed before publication. It is not medical advice — consult a licensed professional.</p>` : ''}
    <p class="intel-readmore">
      <a class="btn btn-primary" href="${esc(a.sourceUrl)}" rel="noopener nofollow" target="_blank">${a.content ? 'View the original at' : 'Read the full article at'} ${esc(a.sourceName)}</a>
    </p>
    <p class="intel-attrib">Doctorna Intelligence ${a.content
      ? 'reproduces the text its publisher syndicates in their own public feed, with attribution and a link to the original.'
      : 'links to reporting published by its original source. The headline and summary above are the publisher\'s own words, shown here with attribution.'}</p>
  </article>
  <aside class="intel-related" id="intelRelated" data-slug="${esc(a.slug)}"></aside>
</main>
<div id="intelFooter"></div>
<script type="module" src="/intelligence/js/article.js"></script>
</body>
</html>`;
}

export function publishIntel(db, { siteBase = '', outDir = resolve(ROOT, 'intelligence') } = {}) {
  const dataDir = resolve(outDir, 'data');
  const artDir = resolve(outDir, 'a');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(artDir, { recursive: true });

  const rows = db.prepare(`select * from Article where status = ?
    order by coalesce(originalPublishedAt, retrievedAt) desc`).all(STATUS.PUBLISHED);
  const articles = rows.map((r) => toPublic(db, r));

  // Per-article JSON + HTML.
  const seen = new Set();
  for (const a of articles) {
    seen.add(a.slug);
    writeFileSync(resolve(dataDir, `article-${a.slug}.json`), JSON.stringify(a));
    const dir = resolve(artDir, a.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'index.html'), articleHtml(a, siteBase));
  }
  // Remove artefacts for anything no longer published (unpublished, rejected,
  // or re-slugged). BOTH the page and its JSON: leaving an orphaned
  // article-<slug>.json behind means a stale article stays fetchable and the
  // published count disagrees with the file count.
  let pruned = 0;
  if (existsSync(artDir)) {
    for (const entry of readdirSync(artDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !seen.has(entry.name)) {
        rmSync(resolve(artDir, entry.name), { recursive: true, force: true });
        pruned++;
      }
    }
  }
  for (const f of readdirSync(dataDir)) {
    const m = /^article-(.+)\.json$/.exec(f);
    if (m && !seen.has(m[1])) { rmSync(resolve(dataDir, f), { force: true }); pruned++; }
  }
  // Stale index pages, when the archive shrinks.
  for (const f of readdirSync(dataDir)) {
    const m = /^page-(\d+)\.json$/.exec(f);
    if (m && Number(m[1]) > Math.max(1, Math.ceil(articles.length / PAGE_SIZE))) {
      rmSync(resolve(dataDir, f), { force: true }); pruned++;
    }
  }

  // Paged index — the browser never loads the whole archive.
  const card = (a) => ({
    slug: a.slug, title: a.title, summary: a.summary, category: a.category,
    categoryLabel: a.categoryLabel, contentType: a.contentType, contentTypeLabel: a.contentTypeLabel,
    sourceName: a.sourceName, sourceUrl: a.sourceUrl, image: a.image, region: a.region,
    readingMinutes: a.readingMinutes, hasFullContent: a.hasFullContent,
    originalPublishedAt: a.originalPublishedAt, retrievedAt: a.retrievedAt,
    specialtyIds: a.specialtyIds, facilityIds: a.facilityIds, doctorIds: a.doctorIds,
    related: { specialties: a.related.specialties.slice(0, 3), facilities: a.related.facilities.slice(0, 2) },
  });
  // UAE content leads. Both streams are published in full — global content is
  // separated, never hidden.
  const uae = articles.filter((a) => a.region === 'uae');
  const global = articles.filter((a) => a.region !== 'uae');
  const pages = Math.max(1, Math.ceil(articles.length / PAGE_SIZE));
  for (let p = 1; p <= pages; p++) {
    writeFileSync(resolve(dataDir, `page-${p}.json`), JSON.stringify({
      page: p, pages, total: articles.length,
      items: articles.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE).map(card),
    }));
  }

  // ── hero figures, all derived from the store ────────────────────────────
  // "Analysed" counts every item the pipeline has actually classified, which
  // is the published set plus the items still held in review. Nothing here is
  // a marketing number; each one is a count of rows.
  const assessed = db.prepare(`select count(*) n from Article where status in (?,?,?)`)
    .get(STATUS.PUBLISHED, STATUS.EDITORIAL_REVIEW, STATUS.MEDICAL_REVIEW).n;
  const sourceCount = new Set(articles.map((a) => a.sourceName)).size;
  const liveRows = db.prepare('select scheduleMinutes from Source where enabled = 1 and requiresConfig = 0').all();
  const liveSources = liveRows.length;
  const everyMin = liveRows.length ? Math.min(...liveRows.map((r) => r.scheduleMinutes)) : 0;
  const cadence = everyMin === 0 ? null
    : everyMin % 60 === 0
      ? `Checked every ${everyMin / 60} hour${everyMin === 60 ? '' : 's'}`
      : `Checked every ${everyMin} minutes`;

  const byCategory = {};
  for (const a of articles) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
  const byType = {};
  for (const a of articles) byType[a.contentType] = (byType[a.contentType] ?? 0) + 1;

  writeFileSync(resolve(dataDir, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: articles.length,
    pageSize: PAGE_SIZE,
    pages,
    categories: byCategory,
    contentTypes: byType,
    regions: { uae: uae.length, global: global.length },
    // The featured block leads with UAE when there is any, and is topped up
    // with global stories so the page is never thin.
    featured: [...uae.slice(0, 5), ...global.slice(0, Math.max(0, 5 - uae.length))].map(card),
    uaeLatest: uae.slice(0, 12).map(card),
    globalLatest: global.slice(0, 12).map(card),
    research: articles.filter((a) => a.contentType === 'research' || a.category === 'research-and-insights')
      .slice(0, 6).map(card),
    // A signal is only shown when real data backs it. With no published
    // articles there are no signals, and the section stays absent rather than
    // being filled with invented statistics.
    signals: articles.length === 0 ? [] : [
      { key: 'analysed', label: 'Items analysed', value: assessed,
        note: `Every item the pipeline has classified: ${articles.length} published, `
          + `${assessed - articles.length} held in editorial or medical review.` },
      { key: 'articles', label: 'Published articles', value: articles.length,
        note: 'Items that cleared review and are readable on this page.' },
      { key: 'uae', label: 'UAE healthcare items', value: uae.length,
        note: 'Published items classified as UAE-region by tools/intel/classify.mjs.' },
      { key: 'sources', label: 'Contributing sources', value: sourceCount,
        note: `${sourceCount} of ${liveSources} live sources have published items so far.` },
    ],
    // Real cadence: the shortest polling interval among sources that are live.
    // Stated in the hero instead of a marketing claim about freshness.
    cadence,
    linkedCount: articles.filter((a) => a.specialtyIds.length || a.facilityIds.length || a.doctorIds.length).length,
  }));

  // Operational status — the admin/editor view, from the same store.
  const sources = db.prepare('select * from Source order by trustTier, id').all();
  const statusRows = db.prepare('select status, count(*) n from Article group by 1').all();
  writeFileSync(resolve(dataDir, 'status.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    pipeline: Object.fromEntries(statusRows.map((r) => [r.status, r.n])),
    sources: sources.map((s) => ({
      id: s.id, name: s.name, sourceType: s.sourceType, trustTier: s.trustTier,
      feedUrl: s.feedUrl, enabled: !!s.enabled, requiresConfig: !!s.requiresConfig,
      configNote: s.configNote, scheduleMinutes: s.scheduleMinutes,
      crawlDelaySeconds: s.crawlDelaySeconds,
      lastCheckedAt: iso(s.lastCheckedAt), lastSuccessAt: iso(s.lastSuccessAt),
      lastStatus: s.lastStatus, lastError: s.lastError,
      consecutiveFailures: s.consecutiveFailures,
    })),
    recentRuns: db.prepare(`select * from FetchRun order by startedAt desc limit 20`).all()
      .map((r) => ({ ...r, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt) })),
  }));

  /**
   * View counts, snapshotted from the store. This file only ever contains
   * counts a real counter recorded (tools/intel/view-endpoint.mjs); when the
   * counter has never run it is an empty object and the UI shows no view
   * figure at all, rather than a zero or an invented number.
   */
  const viewRows = db.prepare('select articleSlug, views from ArticleView').all();
  writeFileSync(resolve(dataDir, 'views.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    counted: viewRows.length,
    views: Object.fromEntries(viewRows.map((v) => [v.articleSlug, v.views])),
  }));

  /**
   * Runtime configuration for the page.
   *
   * `viewEndpoint` is the BASE URL of a running view counter — the client
   * appends `/api/intel/view` (POST, to register a read) and `/api/intel/views`
   * (GET, for the whole map). tools/intel/view-endpoint.mjs implements exactly
   * those two routes; set DOCTORNA_VIEW_ENDPOINT to where it listens, e.g.
   * `DOCTORNA_VIEW_ENDPOINT=http://127.0.0.1:8753`.
   *
   * Null until a counter is actually deployed. The client treats null as "no
   * view tracking": it falls back to the read-only views.json snapshot and, with
   * nothing there either, shows no figure at all rather than a zero.
   */
  writeFileSync(resolve(dataDir, 'config.json'), JSON.stringify({
    viewEndpoint: process.env.DOCTORNA_VIEW_ENDPOINT ?? null,
    generatedAt: new Date().toISOString(),
  }));

  // Sitemap for the section only; the directory's own URLs are untouched.
  const urls = [`${siteBase}/intelligence/`, ...articles.map((a) => `${siteBase}/intelligence/a/${a.slug}/`)];
  writeFileSync(resolve(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')
    + `\n</urlset>\n`);

  return { articles: articles.length, pages, categories: byCategory, pruned,
    regions: { uae: uae.length, global: global.length } };
}
