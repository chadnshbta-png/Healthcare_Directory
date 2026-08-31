#!/usr/bin/env node
/**
 * Article view counter — reference endpoint.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Intelligence section is static files. A static file cannot count anything
 * shared, and `localStorage` counts one browser, not the world — presenting it
 * as a view count would be a fabricated global statistic. So the count lives
 * where a count can actually live: a small server process with the SQLite store
 * behind it.
 *
 * This is a REFERENCE implementation: complete, tested, and deliberately
 * minimal. Point the page at it (or at your own service implementing the same
 * two routes) and the counter is real. Leave it undeployed and the UI simply
 * shows no view count — never a zero, never an invented number.
 *
 * CONTRACT
 *   POST /api/intel/view      { "slug": "<article-slug>" }  -> { slug, views }
 *   GET  /api/intel/views                                   -> { "<slug>": n }
 *
 * One increment per slug per client per 12h is enforced server-side by a
 * coarse client key (IP + user-agent hash), so a refresh loop cannot inflate a
 * number. This is deduplication, not identification: the key is a hash, it is
 * never stored against the article, and it expires.
 *
 * Usage:
 *   node tools/intel/view-endpoint.mjs [--port=8753] [--origin=http://127.0.0.1:8752]
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { openStore, now } from './store.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const PORT = Number(args.port ?? 8753);
const ORIGIN = args.origin ?? '*';
const db = openStore(args.db);

/** slug -> Map(clientKey -> lastSeen). Coarse, in-memory, expiring. */
const recent = new Map();
const WINDOW = 12 * 3600_000;
function alreadyCounted(slug, key) {
  const m = recent.get(slug) ?? new Map();
  const t = now();
  for (const [k, seen] of m) if (t - seen > WINDOW) m.delete(k);
  if (m.has(key)) { recent.set(slug, m); return true; }
  m.set(key, t);
  recent.set(slug, m);
  return false;
}

const json = (res, code, body) => {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return json(res, 204, {});

  if (req.method === 'GET' && url.pathname === '/api/intel/views') {
    const rows = db.prepare('select articleSlug, views from ArticleView').all();
    return json(res, 200, Object.fromEntries(rows.map((r) => [r.articleSlug, r.views])));
  }

  if (req.method === 'POST' && url.pathname === '/api/intel/view') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2000) req.destroy(); });
    req.on('end', () => {
      let slug;
      try { slug = String(JSON.parse(raw).slug ?? '').trim(); } catch { return json(res, 400, { error: 'bad json' }); }
      if (!/^[a-z0-9-]{4,120}$/.test(slug)) return json(res, 400, { error: 'bad slug' });
      // The slug must be a real published article, so the table cannot be
      // seeded with counts for things that do not exist.
      const known = db.prepare('select 1 ok from Article where slug = ? and status = ?').get(slug, 'PUBLISHED');
      if (!known) return json(res, 404, { error: 'unknown article' });

      const key = createHash('sha256')
        .update(`${req.socket.remoteAddress ?? ''}|${req.headers['user-agent'] ?? ''}`)
        .digest('hex').slice(0, 16);
      const t = now();
      if (!alreadyCounted(slug, key)) {
        db.prepare(`insert into ArticleView (articleSlug, views, firstViewAt, lastViewAt)
          values (?,1,?,?)
          on conflict(articleSlug) do update set views = views + 1, lastViewAt = excluded.lastViewAt`)
          .run(slug, t, t);
      }
      const row = db.prepare('select views from ArticleView where articleSlug = ?').get(slug);
      return json(res, 200, { slug, views: row?.views ?? 0 });
    });
    return undefined;
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`view endpoint listening on http://127.0.0.1:${PORT}`);
  console.log(`  POST /api/intel/view   {"slug":"..."}`);
  console.log(`  GET  /api/intel/views`);
});
