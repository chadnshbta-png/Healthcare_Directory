/**
 * The pipeline.
 *
 *   due sources -> fetch -> normalise -> deduplicate -> classify -> AI (if
 *   configured) -> entity linking -> editorial / medical gate -> READY
 *
 * It is a recurring job, not an importer: every stage is resumable, every item
 * carries the stage it reached, and a source that fails backs off rather than
 * blocking the rest. Nothing here runs during a page request.
 */
import { createHash, randomUUID } from 'node:crypto';
import { STATUS, now, slugify } from './store.mjs';
import { dueSources } from './sources.mjs';
import { fetchItems } from './rss.mjs';
import { ruleClassify, aiConfig, analyse } from './classify.mjs';
import { linkEntities } from './entities.mjs';

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

/** Title reduced to comparable form: case, punctuation and filler removed. */
const STOPWORDS = /\b(the|a|an|of|for|to|in|on|and|as|at|by|with|from|new|says?|amid|its|their|his|her|our|they|them|this|that|these|those|is|are|was|were|be|been|has|have|had|will|would|can|could|after|over|into|about|more|most)\b/g;

export function normalizeTitle(t) {
  return String(t ?? '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(STOPWORDS, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Strip tracking noise so the same page does not look like two URLs. */
export function canonicalise(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref|source)/i.test(k)) u.searchParams.delete(k);
    }
    u.hostname = u.hostname.replace(/^www\./i, '');
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch { return String(url ?? '').trim(); }
}

/**
 * A coarse similarity key over the significant words of the title. Two reports
 * of the same event by different outlets usually share most of them, so this
 * groups them into one story WITHOUT merging the source records.
 */
export function simHashOf(title) {
  const words = [...new Set(normalizeTitle(title).split(' ').filter((w) => w.length > 3))];
  if (words.length === 0) return null;
  // Keep the most CONTENT-BEARING words, not the alphabetically first: sorting
  // then slicing let one extra filler word displace a real one and change the
  // key, so two wordings of the same event stopped matching. Longest-first is
  // stable against added filler; the alphabetical sort afterwards makes the key
  // order-independent.
  const key = words
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, 5)
    .sort()
    .join(' ');
  return sha(key).slice(0, 16);
}

/**
 * Duplicate decision, in order of confidence. Never on title alone.
 *   1 same canonical URL           -> the same page
 *   2 same source hash             -> the same feed item seen again
 *   3 same content hash            -> identical text under a different URL
 *   4 same normalised title AND same day        -> a re-run of one report
 *   5 same simhash from ANOTHER source, same day -> the same STORY, kept as a
 *     separate record and grouped by storyId, because two outlets reporting one
 *     event are two sources, not one article.
 */
export function findDuplicate(db, cand) {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  let hit = q('select id, storyId from Article where canonicalUrl = ?', cand.canonicalUrl);
  if (hit) return { of: hit.id, reason: 'canonical_url', storyId: hit.storyId, hard: true };
  hit = q('select id, storyId from Article where sourceHash = ?', cand.sourceHash);
  if (hit) return { of: hit.id, reason: 'source_hash', storyId: hit.storyId, hard: true };
  hit = q('select id, storyId from Article where contentHash = ?', cand.contentHash);
  if (hit) return { of: hit.id, reason: 'content_hash', storyId: hit.storyId, hard: true };

  const day = 86_400_000;
  const t = cand.originalPublishedAt ?? cand.retrievedAt;
  hit = q(`select id, storyId from Article
           where normalizedTitle = ? and abs(coalesce(originalPublishedAt, retrievedAt) - ?) < ?`,
    cand.normalizedTitle, t, day);
  if (hit) return { of: hit.id, reason: 'normalized_title_same_day', storyId: hit.storyId, hard: true };

  if (cand.simHash) {
    hit = q(`select id, storyId from Article
             where simHash = ? and sourceId <> ?
               and abs(coalesce(originalPublishedAt, retrievedAt) - ?) < ?`,
      cand.simHash, cand.sourceId, t, 2 * day);
    // Soft: a different outlet covering the same event. Kept, grouped.
    if (hit) return { of: hit.id, reason: 'same_story_other_source', storyId: hit.storyId, hard: false };
  }
  return null;
}

/** Fetch + ingest one source. Returns a run summary. */
export async function runSource(db, source, { dataDir, directory, ai, dryRun = false } = {}) {
  const runId = randomUUID();
  const startedAt = now();
  db.prepare(`insert into FetchRun (id, sourceId, startedAt, status) values (?,?,?,?)`)
    .run(runId, source.id, startedAt, 'RUNNING');

  // Conditional request: an unchanged feed costs a 304 and no parsing at all.
  const res = await fetchItems(source, { etag: source.etag, lastModified: source.lastModified });
  const stats = { seen: 0, added: 0, updated: 0, duplicate: 0, failed: 0, medical: 0 };

  if (res.notModified) {
    if (!dryRun) {
      db.prepare(`update Source set lastCheckedAt=?, lastStatus=?, status=?, lastError=null,
        consecutiveFailures=0, updatedAt=? where id=?`)
        .run(startedAt, 'NOT_MODIFIED', 'LIVE', now(), source.id);
      db.prepare(`update FetchRun set finishedAt=?, status=?, httpStatus=? where id=?`)
        .run(now(), 'NOT_MODIFIED', 304, runId);
    }
    return { source: source.id, ok: true, notModified: true, httpStatus: 304, stats };
  }

  if (res.error || res.skipped) {
    const msg = res.error ?? res.skipped;
    const rateLimited = res.httpStatus === 429 || res.httpStatus === 503;
    if (!dryRun) {
      db.prepare(`update Source set lastCheckedAt=?, lastFailureAt=?, lastStatus=?, status=?,
        lastError=?, consecutiveFailures=consecutiveFailures+1, updatedAt=? where id=?`)
        .run(startedAt, startedAt, 'FAILED',
          rateLimited ? 'RATE_LIMITED' : 'FAILED', msg, startedAt, source.id);
      db.prepare(`update FetchRun set finishedAt=?, status=?, httpStatus=?, error=? where id=?`)
        .run(now(), 'FAILED', res.httpStatus ?? 0, msg, runId);
    }
    return { source: source.id, ok: false, error: msg, httpStatus: res.httpStatus, stats };
  }

  for (const item of res.items) {
    stats.seen++;
    const canonicalUrl = canonicalise(item.link);
    const cand = {
      sourceId: source.id,
      canonicalUrl,
      sourceHash: sha(`${source.id}${item.guid ?? canonicalUrl}`),
      contentHash: sha(`${normalizeTitle(item.title)}${(item.excerpt ?? '').slice(0, 400)}`),
      normalizedTitle: normalizeTitle(item.title),
      simHash: simHashOf(item.title),
      originalPublishedAt: item.publishedAt,
      retrievedAt: startedAt,
    };

    const dup = findDuplicate(db, cand);
    if (dup?.hard) {
      stats.duplicate++;
      if (!dryRun) {
        // Seen before. Record the check; update the text only if it changed.
        db.prepare('update Article set lastCheckedAt=? where id=?').run(startedAt, dup.of);
        const prev = db.prepare('select contentHash, status from Article where id=?').get(dup.of);
        if (prev && prev.contentHash !== cand.contentHash) {
          db.prepare(`update Article set excerpt=?, contentHash=?, updatedAt=?,
            processingStatus=? where id=?`)
            .run(item.excerpt ?? null, cand.contentHash, startedAt, 'UPDATED', dup.of);
          stats.updated++;
        }
      }
      continue;
    }

    // Classification — deterministic by default, model-assisted when configured.
    const rule = ruleClassify({
      title: item.title, excerpt: item.excerpt, categories: item.categories,
      defaultCategory: source.defaultCategory, sourceRegion: source.region,
    });
    const region = rule.region;
    let classifier = rule.classifier;
    let category = rule.category;
    let contentType = rule.contentType;
    let summary = null;
    let analysis = null;
    let tags = rule.tags;
    let requiresMedical = rule.requiresMedicalReview;

    if (ai?.available) {
      const out = await analyse({ ...item, sourceName: source.name }, ai);
      if (out.ok && out.result) {
        classifier = out.model;
        category = out.result.category || category;
        contentType = out.result.contentType || contentType;
        summary = (out.result.summary || '').trim() || null;
        tags = Array.isArray(out.result.tags) && out.result.tags.length ? out.result.tags.slice(0, 8) : tags;
        if (out.result.clinical === true) requiresMedical = true;
      }
    }

    const id = randomUUID();
    const slug = slugify(item.title, cand.contentHash);
    // No AI: the summary is the publisher's own excerpt, verbatim. Nothing is
    // written on their behalf.
    const finalSummary = summary ?? item.excerpt ?? null;

    // The gate. Clinical content never reaches READY without a human.
    const status = requiresMedical ? STATUS.MEDICAL_REVIEW
      : source.trustTier <= 2 ? STATUS.READY
        : STATUS.EDITORIAL_REVIEW;
    if (requiresMedical) stats.medical++;

    if (!dryRun) {
      db.prepare(`insert into Article (
        id, slug, sourceId, sourceName, sourceUrl, canonicalUrl, title, normalizedTitle,
        excerpt, summary, analysis, content, image, author, category, contentType, tags,
        originalPublishedAt, retrievedAt, updatedAt, sourceHash, contentHash, simHash,
        storyId, duplicateOfId, duplicateReason, status, fetchStatus, processingStatus,
        classificationStatus, classifier, editorialStatus, medicalReviewStatus,
        lastCheckedAt, lastProcessedAt, region, retryCount
      ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`)
        .run(id, slug, source.id, source.name, item.link, canonicalUrl, item.title,
          cand.normalizedTitle, item.excerpt ?? null, finalSummary, analysis, null,
          item.image ?? null, item.author ?? null, category, contentType, JSON.stringify(tags),
          item.publishedAt, startedAt, startedAt, cand.sourceHash, cand.contentHash, cand.simHash,
          dup?.storyId ?? id, dup && !dup.hard ? dup.of : null,
          dup && !dup.hard ? dup.reason : null,
          status, 'OK', 'NORMALIZED', 'CLASSIFIED', classifier,
          status === STATUS.EDITORIAL_REVIEW ? 'PENDING' : 'AUTO_APPROVED',
          requiresMedical ? 'PENDING' : 'NOT_REQUIRED',
          startedAt, startedAt, region);

      // Entity links, from the publisher's own words only.
      const links = linkEntities(`${item.title} ${item.excerpt ?? ''}`, directory);
      const ins = db.prepare(`insert or ignore into ArticleEntity
        (articleId, entityType, entityId, entityLabel, confidence, method, createdAt)
        values (?,?,?,?,?,?,?)`);
      for (const l of links) {
        ins.run(id, l.entityType, l.entityId, l.entityLabel, l.confidence, l.method, startedAt);
      }
    }
    stats.added++;
  }

  if (!dryRun) {
    // Store the validators so the next run can ask "has anything changed?".
    db.prepare(`update Source set lastCheckedAt=?, lastSuccessAt=?, lastStatus=?, status=?,
      lastError=null, consecutiveFailures=0, etag=?, lastModified=?, updatedAt=? where id=?`)
      .run(startedAt, now(), 'OK', 'LIVE', res.etag ?? null, res.lastModified ?? null,
        now(), source.id);
    db.prepare(`update FetchRun set finishedAt=?, status=?, httpStatus=?, itemsSeen=?, itemsNew=?,
      itemsUpdated=?, itemsDuplicate=? where id=?`)
      .run(now(), 'OK', res.httpStatus, stats.seen, stats.added, stats.updated, stats.duplicate, runId);
  }
  return { source: source.id, ok: true, httpStatus: res.httpStatus, stats };
}

/** One pass over every due source. */
export async function runPipeline(db, { dataDir, directory, force = false, only = null, dryRun = false } = {}) {
  const ai = aiConfig();
  const sources = dueSources(db, { force, only });
  const results = [];
  for (const s of sources) {
    results.push(await runSource(db, s, { dataDir, directory, ai, dryRun }));
  }
  return { ai, sources: sources.length, results };
}

/** Promote READY -> PUBLISHED. The editorial act, kept explicit and separate. */
export function publishReady(db, { limit = 500 } = {}) {
  const rows = db.prepare(`select id from Article where status = ? order by
    coalesce(originalPublishedAt, retrievedAt) desc limit ?`).all(STATUS.READY, limit);
  const t = now();
  const up = db.prepare('update Article set status=?, publishedAt=coalesce(publishedAt,?), updatedAt=? where id=?');
  for (const r of rows) up.run(STATUS.PUBLISHED, t, t, r.id);
  return rows.length;
}
