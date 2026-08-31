/**
 * Doctorna Intelligence — the content store.
 * ---------------------------------------------------------------------------
 * A separate SQLite database from the directory's. Intelligence CONSUMES the
 * healthcare data (doctors, facilities, specialties) and must never be able to
 * write to it, so the two never share a connection: the directory's db is
 * opened read-only wherever entity linking needs it.
 *
 * The schema is deliberately explicit about provenance. Every row records where
 * it came from, when the source published it, when we retrieved it and what we
 * did to it — because an article that cannot answer those questions has no
 * business being published.
 *
 * Status is a single enumerated column per stage rather than a scatter of
 * booleans, so a partially processed item is always in exactly one describable
 * state and a failed run can be resumed from it.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..', '..');
export const DEFAULT_DB = resolve(ROOT, 'intel', 'intel.db');

/** Pipeline stages, in order. An item only ever moves forward. */
export const STATUS = {
  FETCHED: 'FETCHED',
  PROCESSING: 'PROCESSING',
  CLASSIFIED: 'CLASSIFIED',
  AI_PROCESSED: 'AI_PROCESSED',
  EDITORIAL_REVIEW: 'EDITORIAL_REVIEW',
  MEDICAL_REVIEW: 'MEDICAL_REVIEW',
  READY: 'READY',
  PUBLISHED: 'PUBLISHED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  DUPLICATE: 'DUPLICATE',
};

/** Editorial vocabulary. Extending either list needs no schema change. */
export const CATEGORIES = [
  'uae-healthcare-news', 'medical-news', 'doctors-and-clinics', 'healthcare-technology',
  'insurance', 'medical-tourism', 'health-and-wellness', 'research-and-insights',
];
export const CATEGORY_LABEL = {
  'uae-healthcare-news': 'UAE Healthcare News',
  'medical-news': 'Medical News',
  'doctors-and-clinics': 'Doctors & Clinics',
  'healthcare-technology': 'Healthcare Technology',
  insurance: 'Insurance',
  'medical-tourism': 'Medical Tourism',
  'health-and-wellness': 'Health & Wellness',
  'research-and-insights': 'Research & Insights',
};
export const CONTENT_TYPES = ['news', 'breaking-news', 'analysis', 'research', 'medical'];
export const CONTENT_TYPE_LABEL = {
  news: 'News', 'breaking-news': 'Breaking News', analysis: 'Analysis',
  research: 'Research', medical: 'Medical',
};

const SCHEMA = `
-- A configured origin we poll. Rows are upserted from tools/intel/sources.mjs,
-- so the registry stays the single place a source is declared.
create table if not exists Source (
  id                text primary key,
  name              text not null,
  homepage          text,
  feedUrl           text,
  sourceType        text not null,          -- official_authority | official_company | research | publication
  trustTier         integer not null,       -- 1 highest. Drives whether AI rewriting is allowed.
  defaultCategory   text,
  scheduleMinutes   integer not null default 360,
  crawlDelaySeconds integer not null default 0,
  enabled           integer not null default 1,
  requiresConfig    integer not null default 0,
  configNote        text,
  lastCheckedAt     integer,
  lastSuccessAt     integer,
  lastStatus        text,
  lastError         text,
  consecutiveFailures integer not null default 0,
  createdAt         integer not null,
  updatedAt         integer not null
);

-- One row per item we have ever seen from a source, whether or not it is
-- published. Nothing is deleted: a rejected or duplicate item keeps its record
-- so the same URL is never reconsidered from scratch.
create table if not exists Article (
  id                  text primary key,
  slug                text unique,
  sourceId            text not null,
  sourceName          text not null,
  sourceUrl           text not null,
  canonicalUrl        text,
  title               text not null,
  normalizedTitle     text not null,
  excerpt             text,
  summary             text,
  analysis            text,
  content             text,
  image               text,
  author              text,
  category            text,
  contentType         text,
  tags                text,                 -- JSON array
  originalPublishedAt integer,
  retrievedAt         integer not null,
  updatedAt           integer not null,
  publishedAt         integer,
  sourceHash          text not null,        -- identity of the fetched item
  contentHash         text not null,        -- identity of its text, for update detection
  simHash             text,                 -- coarse similarity key for near-duplicates
  storyId             text,                 -- groups independent reports of one event
  duplicateOfId       text,
  duplicateReason     text,
  status              text not null,
  fetchStatus         text,
  processingStatus    text,
  classificationStatus text,
  classifier          text,                 -- 'rule_based' or the AI model actually used
  editorialStatus     text,
  medicalReviewStatus text,
  reviewNote          text,
  lastCheckedAt       integer,
  lastProcessedAt     integer,
  error               text,
  retryCount          integer not null default 0,
  foreign key (sourceId) references Source(id)
);
create index if not exists idx_article_status on Article(status);
create index if not exists idx_article_source on Article(sourceId);
create index if not exists idx_article_published on Article(publishedAt);
create index if not exists idx_article_hash on Article(sourceHash);
create index if not exists idx_article_content on Article(contentHash);
create index if not exists idx_article_normtitle on Article(normalizedTitle);
create index if not exists idx_article_story on Article(storyId);

-- Links to the EXISTING directory, by stable id. Never by display name.
-- entityType: doctor | facility | specialty | location
create table if not exists ArticleEntity (
  articleId   text not null,
  entityType  text not null,
  entityId    text not null,
  entityLabel text,
  confidence  real not null default 0,
  method      text not null,
  createdAt   integer not null,
  primary key (articleId, entityType, entityId),
  foreign key (articleId) references Article(id) on delete cascade
);
create index if not exists idx_ae_entity on ArticleEntity(entityType, entityId);

-- One row per pipeline run per source: the audit trail for scheduling,
-- retries and failed-source handling.
create table if not exists FetchRun (
  id           text primary key,
  sourceId     text not null,
  startedAt    integer not null,
  finishedAt   integer,
  status       text not null,
  httpStatus   integer,
  itemsSeen    integer not null default 0,
  itemsNew     integer not null default 0,
  itemsUpdated integer not null default 0,
  itemsDuplicate integer not null default 0,
  error        text
);
create index if not exists idx_run_source on FetchRun(sourceId, startedAt);
`;

/**
 * Columns added after the first release. Applied with ALTER so an existing
 * store upgrades in place instead of being rebuilt — the ingested corpus and
 * its provenance are the whole point and must survive a schema change.
 */
const MIGRATIONS = [
  ['Source', 'etag', 'text'],
  ['Source', 'lastModified', 'text'],
  ['Source', 'lastFailureAt', 'integer'],
  ['Source', 'status', 'text'],
  ['Source', 'reason', 'text'],
  ['Source', 'region', 'text'],          // 'uae' | 'gcc' | 'global'
  ['Article', 'region', 'text'],
  ['Article', 'notModifiedCount', 'integer'],
];

/** Source lifecycle, as distinct from the per-run lastStatus. */
export const SOURCE_STATUS = {
  LIVE: 'LIVE',
  NEEDS_CONFIGURATION: 'NEEDS_CONFIGURATION',
  DISABLED: 'DISABLED',
  FAILED: 'FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_MODIFIED: 'NOT_MODIFIED',
};

/** Open (and create) the store. */
export function openStore(path = DEFAULT_DB) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('pragma journal_mode = WAL');
  db.exec('pragma foreign_keys = ON');
  db.exec(SCHEMA);
  for (const [table, col, type] of MIGRATIONS) {
    const has = db.prepare(`pragma table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`alter table ${table} add column ${col} ${type}`);
  }
  return db;
}

/** The directory's own database, READ-ONLY. Intelligence never writes to it. */
export function openDirectoryDb(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export const now = () => Date.now();

/** Stable slug from a title, with a short hash so two same-titled items differ. */
export function slugify(title, hash) {
  const base = String(title).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'article';
  return `${base}-${String(hash).slice(0, 8)}`;
}
