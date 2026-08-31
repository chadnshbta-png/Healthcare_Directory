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

export function parseFeed(xml, base = null) {
  return blocks(xml).map(({ kind, body }) => {
    const link = kind === 'entry'
      ? (atomLink(body) || strip(tag(body, ['id'])))
      : (strip(tag(body, ['link'])) || atomLink(body));
    const summaryRaw = tag(body, ['description', 'summary', 'content:encoded', 'content']);
    const img = /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image/i.exec(body)?.[1]
      ?? /<media:content[^>]*url=["']([^"']+)["']/i.exec(body)?.[1]
      ?? /<media:thumbnail[^>]*url=["']([^"']+)["']/i.exec(body)?.[1]
      ?? /<img[^>]+src=["']([^"']+)["']/i.exec(decode(summaryRaw))?.[1]
      ?? null;
    return {
      title: strip(tag(body, ['title'])),
      link: absolutise(link ? decode(link).trim() : '', base) ?? '',
      guid: strip(tag(body, ['guid', 'id'])) || null,
      excerpt: strip(summaryRaw).slice(0, 600) || null,
      author: strip(tag(body, ['dc:creator', 'author', 'name'])) || null,
      publishedAt: parseDate(tag(body, ['pubDate', 'published', 'updated', 'dc:date'])),
      categories: [...String(body).matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/gi)]
        .map((c) => strip(c[1])).filter(Boolean).slice(0, 8),
      image: absolutise(img, base),
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
