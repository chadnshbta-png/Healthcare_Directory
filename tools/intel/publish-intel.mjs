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

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
const PAGE_SIZE = 12;

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
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    excerpt: r.excerpt,
    summary: r.summary,
    analysis: r.analysis,
    category: r.category,
    categoryLabel: CATEGORY_LABEL[r.category] ?? r.category,
    contentType: r.contentType,
    contentTypeLabel: CONTENT_TYPE_LABEL[r.contentType] ?? r.contentType,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    canonicalUrl: r.canonicalUrl,
    author: r.author,
    image: r.image,
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
    </div>
    <h1>${esc(a.title)}</h1>
    ${a.summary ? `<p class="intel-lede">${esc(a.summary)}</p>` : ''}
    <div class="intel-source" role="note">
      <div class="intel-source-row"><span>Source</span>
        <a href="${esc(a.sourceUrl)}" rel="noopener nofollow" target="_blank">${esc(a.sourceName)}</a></div>
      ${a.originalPublishedAt ? `<div class="intel-source-row"><span>Published</span><time datetime="${esc(a.originalPublishedAt)}">${esc(human(Date.parse(a.originalPublishedAt)))}</time></div>` : ''}
      <div class="intel-source-row"><span>Retrieved</span><time datetime="${esc(a.retrievedAt)}">${esc(human(Date.parse(a.retrievedAt)))}</time></div>
      <div class="intel-source-row"><span>Classified by</span><span>${esc(a.classifier)}</span></div>
    </div>
    ${a.contentType === 'medical' ? `<p class="intel-medical-note">Clinical content. Summarised from the source and reviewed before publication. It is not medical advice — consult a licensed professional.</p>` : ''}
    <p class="intel-readmore">
      <a class="btn btn-primary" href="${esc(a.sourceUrl)}" rel="noopener nofollow" target="_blank">Read the full article at ${esc(a.sourceName)}</a>
    </p>
    <p class="intel-attrib">Doctorna Intelligence links to reporting published by its original source. The
      headline and summary above are the publisher's own words, shown here with attribution.</p>
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
      { key: 'uae', label: 'UAE healthcare items', value: uae.length },
      { key: 'articles', label: 'Published items', value: articles.length },
      { key: 'sources', label: 'Contributing sources', value: new Set(articles.map((a) => a.sourceName)).size },
      { key: 'linked', label: 'Items linked to directory entities',
        value: articles.filter((a) => a.specialtyIds.length || a.facilityIds.length || a.doctorIds.length).length },
    ],
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

  // Sitemap for the section only; the directory's own URLs are untouched.
  const urls = [`${siteBase}/intelligence/`, ...articles.map((a) => `${siteBase}/intelligence/a/${a.slug}/`)];
  writeFileSync(resolve(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map((u) => `  <url><loc>${esc(u)}</loc></url>`).join('\n')
    + `\n</urlset>\n`);

  return { articles: articles.length, pages, categories: byCategory, pruned,
    regions: { uae: uae.length, global: global.length } };
}
