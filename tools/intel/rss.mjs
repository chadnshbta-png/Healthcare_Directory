/**
 * RSS / Atom connector.
 *
 * One connector interface, so adding a source is configuration rather than
 * code: `fetchItems(source) -> { httpStatus, items[] }`. An items[] entry is
 * the publisher's OWN words — title, their excerpt, their link, their date. We
 * never fetch the article body: republishing full text is a rights question,
 * not a technical one, so Intelligence stores a short attributed excerpt and
 * links out. That is a deliberate limitation, recorded here so it is not
 * mistaken for an oversight.
 *
 * The parser is intentionally small and defensive rather than a dependency: it
 * reads the handful of fields the pipeline needs and ignores everything else.
 */

const UA = 'DoctornaIntelligence/1.0 (+https://doctorna.ae)';
/** Per-host wall clock, so a declared crawl-delay is actually honoured. */
const lastHit = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
const strip = (s) => decode(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, names) => {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(block);
    if (m) return m[1];
  }
  return '';
};

/** Atom links carry the URL in an attribute rather than a text node. */
function atomLink(block) {
  const alt = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block)
    ?? /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);
  return alt ? decode(alt[1]) : '';
}

/** RFC-822 and ISO-8601 both appear in the wild. Unparseable -> null, never a guess. */
function parseDate(raw) {
  const s = strip(raw);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** Split a feed document into item/entry blocks. */
function blocks(xml) {
  const out = [];
  const re = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push({ kind: m[1].toLowerCase(), body: m[2] });
  return out;
}

/**
 * Sanitise publisher HTML down to a small, safe editorial subset.
 *
 * Feed HTML is third-party markup: it can carry scripts, iframes, styles,
 * event handlers and tracking pixels. Rendering it verbatim would hand an
 * external publisher script execution on our origin. Everything outside the
 * allow-list is dropped and its text kept, so the ARTICLE survives and the
 * markup does not.
 */
const ALLOWED = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'blockquote',
  'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'figure', 'figcaption', 'img']);

export function sanitiseHtml(raw, base = null) {
  let html = decode(String(raw ?? ''));
  // Remove whole dangerous elements, content and all.
  html = html.replace(/<(script|style|iframe|object|embed|form|input|noscript|svg)[\s\S]*?<\/\1>/gi, '');
  html = html.replace(/<(script|style|iframe|object|embed|form|input|noscript|svg)\b[^>]*\/?>/gi, '');

  html = html.replace(/<\/?([a-z0-9-]+)((?:\s[^>]*)?)\/?>/gi, (m, tagName, attrs) => {
    const t = String(tagName).toLowerCase();
    if (!ALLOWED.has(t)) return '';                       // drop the tag, keep its text
    if (m.startsWith('</')) return `</${t}>`;
    const keep = [];
    if (t === 'a') {
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const abs = href ? absolutise(href, base) : null;
      if (!abs) return '';                                 // a link we cannot resolve is not a link
      keep.push(`href="${abs.replace(/"/g, '&quot;')}"`, 'target="_blank"', 'rel="noopener nofollow"');
    } else if (t === 'img') {
      const src = /src\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
      const abs = src ? absolutise(src, base) : null;
      if (!abs) return '';
      const alt = /alt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
      keep.push(`src="${abs.replace(/"/g, '&quot;')}"`, `alt="${alt.replace(/"/g, '&quot;')}"`,
        'loading="lazy"', 'decoding="async"');
      return `<img ${keep.join(' ')}>`;
    }
    return `<${t}${keep.length ? ' ' + keep.join(' ') : ''}>`;
  });

  // Collapse the empties a strip like that leaves behind.
  html = html.replace(/<p>\s*<\/p>/gi, '').replace(/(\s*<br\s*\/?>\s*){3,}/gi, '<br><br>');
  return html.replace(/\s+/g, ' ').trim();
}

/** Plain text of some HTML, for word counts and reading time. */
export const textOf = (html) => decode(String(html ?? '')).replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ').trim();

/**
 * Resolve a URL found in a feed against the feed's own address.
 *
 * Feeds routinely carry site-relative paths — DoH Abu Dhabi publishes images as
 * `/-/media/...`. Emitted as-is they resolve against OUR origin and 404 on
 * every page that shows the card. Anything that will not resolve to http(s) is
 * dropped rather than guessed at.
 */
function absolutise(u, base) {
  const raw = String(u ?? '').trim();
  if (!raw) return null;
  try {
    const abs = base ? new URL(raw, base) : new URL(raw);
    return abs.protocol === 'http:' || abs.protocol === 'https:' ? abs.toString() : null;
  } catch { return null; }
}

/**
 * Is this URL actually a picture OF THE STORY?
 *
 * Feeds carry three kinds of <img> that are not article imagery, and taking
 * the first one in the body promotes them to being the lead photograph:
 *
 *   · CMS sprites inlined in the prose — WordPress drops a 613-byte ™ glyph
 *     from s.w.org into PureHealth's body text, and that was winning
 *   · tracking pixels and spacers
 *   · the publisher's own "no image available" placeholder, which five DoH
 *     stories currently share byte-for-byte
 *
 * None of these are deleted from the record. They are simply not treated as
 * the story's picture, because they are not one. Returns the URL when it is
 * usable, null when it is not.
 */
const SPRITE_HOST = [/(?:^|\.)s\.w\.org$/i];
const SPRITE_PATH = [
  /\/emoji\//i,
  /\/wp-includes\/images\//i,
  /\/(?:tracking|beacon|spacer)[-._/]/i,
  /(?:^|\/)(?:1x1|blank|spacer|pixel)\.(?:gif|png)$/i,
  // The FILE has to be the placeholder, not merely a folder named after one:
  // DoH Abu Dhabi keeps real photographs inside a directory it calls
  // `no-image-news/`, so only the leaf name is tested.
  /(?:^|\/)(?:no[-_]?image[^/]*|noimage|placeholder|default[-_]?news)\.[a-z0-9]+$/i,
];
export function usableImage(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (SPRITE_HOST.some((re) => re.test(u.host))) return null;
  if (SPRITE_PATH.some((re) => re.test(u.pathname))) return null;
  return url;
}

export function parseFeed(xml, base = null) {
  return blocks(xml).map(({ kind, body }) => {
    const link = kind === 'entry'
      ? (atomLink(body) || strip(tag(body, ['id'])))
      : (strip(tag(body, ['link'])) || atomLink(body));
    /**
     * A feed carries two different things and they must not be conflated:
     *
     *   description / summary   the publisher's own teaser
     *   content:encoded         the publisher's own FULL article body, which
     *                           some publishers deliberately syndicate
     *
     * We keep both. Where a publisher chooses to put the whole article in their
     * public feed, that is theirs to give and ours to render with attribution;
     * where they publish only a teaser we keep the teaser and link out. We
     * never go and fetch a body they did not syndicate.
     */
    const encoded = tag(body, ['content:encoded']);
    const summaryRaw = tag(body, ['description', 'summary', 'content'])
      || encoded;   // some feeds carry only content:encoded
    /** Every <img> in a blob, in order, resolved and quality-filtered. */
    const imgsIn = (html) => [...String(decode(html) ?? '')
      .matchAll(/<img[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => usableImage(absolutise(m[1], base)))
      .filter(Boolean);
    // Declared media first — a publisher that names an enclosure means it.
    // Then the body, scanned for the first image that is actually a picture
    // rather than the first image of any kind: DoH Abu Dhabi's <description>
    // is nothing but an escaped <img>, but PureHealth's body opens with an
    // emoji sprite, and taking [0] blindly picked the sprite.
    const img = usableImage(absolutise(
      /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i.exec(body)?.[1]
      ?? /<media:content[^>]*url=["']([^"']+)["']/i.exec(body)?.[1]
      ?? /<media:thumbnail[^>]*url=["']([^"']+)["']/i.exec(body)?.[1]
      ?? '', base))
      ?? imgsIn(summaryRaw)[0]
      ?? imgsIn(encoded)[0]
      ?? null;
    return {
      title: strip(tag(body, ['title'])),
      link: absolutise(link ? decode(link).trim() : '', base) ?? '',
      guid: strip(tag(body, ['guid', 'id'])) || null,
      excerpt: strip(summaryRaw).slice(0, 600) || null,
      // The publisher's full body, only when THEY syndicated it. Sanitised,
      // structure preserved. Null when they published a teaser only.
      contentHtml: (() => {
        const src = encoded || (strip(summaryRaw).length > 900 ? summaryRaw : '');
        if (!src) return null;
        const clean = sanitiseHtml(src, base);
        return textOf(clean).length >= 400 ? clean : null;
      })(),
      author: strip(tag(body, ['dc:creator', 'author', 'name'])) || null,
      publishedAt: parseDate(tag(body, ['pubDate', 'published', 'updated', 'dc:date'])),
      categories: [...String(body).matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
        .map((c) => strip(c[1])).filter(Boolean).slice(0, 8),
      image: img,
    };
  }).filter((it) => it.title && it.link);
}

/**
 * Fetch one source. Conditional on ETag / Last-Modified so an unchanged feed
 * costs a 304 rather than a full download, and the host's crawl-delay is
 * respected before the request is made.
 */
export async function fetchItems(source, { etag = null, lastModified = null, timeoutMs = 20000 } = {}) {
  if (!source.feedUrl) {
    return { httpStatus: 0, items: [], skipped: 'no feed url configured' };
  }
  const host = new URL(source.feedUrl).host;
  const delay = (source.crawlDelaySeconds ?? 0) * 1000;
  if (delay > 0) {
    const since = Date.now() - (lastHit.get(host) ?? 0);
    if (since < delay) await sleep(delay - since);
  }
  lastHit.set(host, Date.now());

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
    if (etag) headers['If-None-Match'] = etag;
    if (lastModified) headers['If-Modified-Since'] = lastModified;
    const res = await fetch(source.feedUrl, { headers, redirect: 'follow', signal: ctl.signal });
    if (res.status === 304) return { httpStatus: 304, items: [], notModified: true };
    if (!res.ok) return { httpStatus: res.status, items: [], error: `HTTP ${res.status}` };
    const xml = await res.text();
    // Resolve relative URLs against the response URL (after redirects).
    const items = parseFeed(xml, res.url || source.feedUrl);
    if (items.length === 0) {
      return { httpStatus: res.status, items: [], error: 'no <item>/<entry> elements parsed' };
    }
    return {
      httpStatus: res.status,
      items,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
    };
  } catch (err) {
    return { httpStatus: 0, items: [], error: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
