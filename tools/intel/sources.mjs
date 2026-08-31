/**
 * The source registry — the ONE place a source is declared.
 *
 * `verifiedAt` means the endpoint was actually requested from this machine and
 * returned a parseable feed. Anything without it carries `requiresConfig: true`
 * and a note saying exactly what is missing; the pipeline skips those and the
 * status report lists them, so an unconfigured source is visible rather than
 * silently absent.
 *
 * NOTHING here is invented. A source with no confirmed public feed URL is
 * declared unconfigured rather than given a plausible-looking guess.
 *
 * trustTier
 *   1  official health authority or regulator — quotable as-is
 *   2  official company / institutional announcement
 *   3  peer-reviewed or research publication
 *   4  trade or general publication
 *
 * `crawlDelaySeconds` mirrors the host's robots.txt where it declares one.
 */
export const SOURCES = [
  {
    id: 'who-news',
    name: 'World Health Organization',
    homepage: 'https://www.who.int/',
    feedUrl: 'https://www.who.int/rss-feeds/news-english.xml',
    sourceType: 'official_authority',
    trustTier: 1,
    defaultCategory: 'medical-news',
    scheduleMinutes: 180,
    crawlDelaySeconds: 0,      // robots.txt declares no crawl-delay for *
    enabled: true,
    verifiedAt: '2026-08-31',  // 200, application/rss+xml, parsed
  },
  {
    id: 'fda-press',
    name: 'U.S. Food & Drug Administration',
    homepage: 'https://www.fda.gov/',
    feedUrl: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml',
    sourceType: 'official_authority',
    trustTier: 1,
    defaultCategory: 'medical-news',
    scheduleMinutes: 360,
    crawlDelaySeconds: 30,     // robots.txt: Crawl-delay: 30
    enabled: true,
    verifiedAt: '2026-08-31',
  },

  // ── UAE / regional ───────────────────────────────────────────────────────
  {
    id: 'doh-abudhabi-news',
    name: 'Department of Health – Abu Dhabi',
    homepage: 'https://www.doh.gov.ae/en',
    feedUrl: 'https://www.doh.gov.ae/rss/news',
    sourceType: 'official_authority',
    trustTier: 1,
    region: 'uae',
    defaultCategory: 'uae-healthcare-news',
    scheduleMinutes: 180,
    crawlDelaySeconds: 5,      // robots.txt absent (404); polling gently anyway
    enabled: true,
    // 200, 50 <item> elements, titles/links/pubDates all present.
    // Observed cadence ~7.9 days between items, so 3h polling is generous.
    verifiedAt: '2026-08-31',
  },
  {
    id: 'purehealth',
    name: 'PureHealth',
    homepage: 'https://www.purehealth.ae/',
    feedUrl: 'https://www.purehealth.ae/feed/',
    sourceType: 'official_company',
    trustTier: 2,
    region: 'uae',
    defaultCategory: 'doctors-and-clinics',
    scheduleMinutes: 360,
    // robots.txt returned 403 so no policy could be read. The feed is a
    // published syndication endpoint, but absent an explicit allowance we poll
    // slowly and identify ourselves.
    crawlDelaySeconds: 15,
    enabled: true,
    verifiedAt: '2026-08-31',
  },
  {
    id: 'omnia-health',
    name: 'Omnia Health Insights',
    homepage: 'https://insights.omnia-health.com/',
    feedUrl: 'https://insights.omnia-health.com/rss.xml',
    sourceType: 'publication',
    trustTier: 4,
    region: 'gcc',
    defaultCategory: 'healthcare-technology',
    scheduleMinutes: 720,
    crawlDelaySeconds: 5,      // robots allows /rss.xml, declares no delay
    enabled: true,
    verifiedAt: '2026-08-31',
  },

  // ── Declared, NOT yet runnable ───────────────────────────────────────────
  // Each was probed from this machine on 2026-08-31 and did not yield a
  // parseable public feed. They are registered so the connector, scheduling and
  // reporting all treat them as first-class, and so configuring one is a
  // one-line change rather than new code.
  {
    id: 'dha',
    name: 'Dubai Health Authority',
    homepage: 'https://www.dha.gov.ae/',
    feedUrl: null,
    sourceType: 'official_authority',
    trustTier: 1,
    defaultCategory: 'uae-healthcare-news',
    scheduleMinutes: 180,
    enabled: true,
    requiresConfig: true,
    configNote: 'No public RSS/Atom endpoint found. Needs either a media-centre feed URL '
      + 'or an authorised API key. The site root responds 200 (text/html) but must not be '
      + 'scraped without permission.',
  },
  {
    id: 'mohap',
    name: 'UAE Ministry of Health and Prevention',
    homepage: 'https://mohap.gov.ae/en',
    feedUrl: null,
    sourceType: 'official_authority',
    trustTier: 1,
    defaultCategory: 'uae-healthcare-news',
    scheduleMinutes: 180,
    enabled: true,
    requiresConfig: true,
    configNote: 'Host did not resolve from this machine (fetch failed). Needs a reachable '
      + 'feed URL, and confirmation the network permits it.',
  },
  {
    id: 'wam-health',
    name: 'Emirates News Agency (WAM)',
    homepage: 'https://www.wam.ae/en',
    feedUrl: null,
    sourceType: 'publication',
    trustTier: 2,
    region: 'uae',
    defaultCategory: 'uae-healthcare-news',
    scheduleMinutes: 120,
    enabled: true,
    requiresConfig: true,
    configNote: 'Probed /en/feed/rss, /en/rss, /rss.xml and /en/feed on 2026-08-31: all return '
      + '200 with non-feed bodies. /sitemap.xml is a sitemap index, not a feed. robots.txt '
      + 'permits these paths, so this needs the correct feed path or an API key from WAM.',
  },
  {
    id: 'ehs',
    name: 'Emirates Health Services',
    homepage: 'https://www.ehs.gov.ae/',
    feedUrl: null,
    sourceType: 'official_authority',
    trustTier: 1,
    region: 'uae',
    defaultCategory: 'uae-healthcare-news',
    scheduleMinutes: 240,
    enabled: true,
    requiresConfig: true,
    configNote: 'Host did not resolve from this machine (fetch failed) on /en/rss and /rss/news. '
      + 'Needs a reachable feed URL and confirmation the network permits it.',
  },
  {
    id: 'seha',
    name: 'SEHA – Abu Dhabi Health Services',
    homepage: 'https://www.seha.ae/',
    feedUrl: null,
    sourceType: 'official_company',
    trustTier: 2,
    region: 'uae',
    defaultCategory: 'doctors-and-clinics',
    scheduleMinutes: 360,
    enabled: true,
    requiresConfig: true,
    configNote: 'Returns HTTP 403 on /rss and /rss/news — the origin refuses automated requests. '
      + 'Needs permission or an official syndication endpoint; not scraped.',
  },
  {
    id: 'm42',
    name: 'M42',
    homepage: 'https://m42.ae/',
    feedUrl: null,
    sourceType: 'official_company',
    trustTier: 2,
    region: 'uae',
    defaultCategory: 'healthcare-technology',
    scheduleMinutes: 360,
    enabled: true,
    requiresConfig: true,
    configNote: 'No feed at /feed/ or /rss/news (HTTP 404). Needs the correct newsroom feed URL.',
  },
];

/**
 * Upsert the registry into the store. Declaration stays in code, state in the
 * db — so re-running never clobbers `etag`, `lastModified` or failure history.
 */
export function syncSources(db) {
  const t = Date.now();
  const up = db.prepare(`
    insert into Source (id, name, homepage, feedUrl, sourceType, trustTier, defaultCategory,
                        scheduleMinutes, crawlDelaySeconds, enabled, requiresConfig, configNote,
                        region, status, reason, createdAt, updatedAt)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(id) do update set
      name=excluded.name, homepage=excluded.homepage, feedUrl=excluded.feedUrl,
      sourceType=excluded.sourceType, trustTier=excluded.trustTier,
      defaultCategory=excluded.defaultCategory, scheduleMinutes=excluded.scheduleMinutes,
      crawlDelaySeconds=excluded.crawlDelaySeconds, enabled=excluded.enabled,
      requiresConfig=excluded.requiresConfig, configNote=excluded.configNote,
      region=excluded.region, reason=excluded.reason,
      -- A source that has run keeps its live status; only an unconfigured or
      -- disabled one is reset from the declaration.
      status=case
        when excluded.requiresConfig = 1 then 'NEEDS_CONFIGURATION'
        when excluded.enabled = 0 then 'DISABLED'
        when Source.status is null or Source.status in ('NEEDS_CONFIGURATION','DISABLED') then 'LIVE'
        else Source.status end,
      updatedAt=excluded.updatedAt`);
  for (const s of SOURCES) {
    const status = s.requiresConfig ? 'NEEDS_CONFIGURATION'
      : s.enabled === false ? 'DISABLED' : 'LIVE';
    up.run(s.id, s.name, s.homepage ?? null, s.feedUrl ?? null, s.sourceType, s.trustTier,
      s.defaultCategory ?? null, s.scheduleMinutes ?? 360, s.crawlDelaySeconds ?? 0,
      s.enabled === false ? 0 : 1, s.requiresConfig ? 1 : 0, s.configNote ?? null,
      s.region ?? 'global', status, s.configNote ?? null, t, t);
  }
  return SOURCES.length;
}

/** Sources whose schedule is due. Honours per-source cadence and backoff. */
export function dueSources(db, { force = false, only = null } = {}) {
  const rows = db.prepare('select * from Source where enabled = 1 order by trustTier, id').all();
  const t = Date.now();
  return rows.filter((s) => {
    if (only && s.id !== only) return false;
    if (s.requiresConfig || !s.feedUrl) return false;
    if (force) return true;
    if (!s.lastCheckedAt) return true;
    // Exponential backoff after repeated failure, capped at 24h, so a broken
    // source degrades quietly instead of being hammered every run.
    const base = s.scheduleMinutes * 60_000;
    const penalty = Math.min(2 ** Math.min(s.consecutiveFailures, 6), 2 ** 6);
    return t - s.lastCheckedAt >= Math.min(base * penalty, 24 * 3600_000);
  });
}
