#!/usr/bin/env node
/**
 * Doctorna Intelligence — the pipeline entry point.
 *
 * This is the ONLY way content moves. It is meant to be run by a scheduler
 * (cron / Task Scheduler / CI), never by a page request, so the public
 * directory is never waiting on a network fetch or a model call.
 *
 *   node tools/intel-cli.mjs sources                list the registry + state
 *   node tools/intel-cli.mjs run [--force] [--only=id] [--dry-run]
 *   node tools/intel-cli.mjs publish [--limit=N]    READY -> PUBLISHED
 *   node tools/intel-cli.mjs export [--base=https://…]   store -> static files
 *   node tools/intel-cli.mjs cycle [--base=…]       run + publish + export
 *   node tools/intel-cli.mjs status                 pipeline + source health
 *   node tools/intel-cli.mjs review --id=… --approve|--reject [--note=…]
 *
 * Scheduling example (every 3 hours):
 *   0 *\/3 * * *  cd /srv/doctorna && node tools/intel-cli.mjs cycle >> logs/intel.log 2>&1
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, STATUS, DEFAULT_DB } from './intel/store.mjs';
import { syncSources, SOURCES } from './intel/sources.mjs';
import { runPipeline, publishReady } from './intel/pipeline.mjs';
import { loadDirectory } from './intel/entities.mjs';
import { publishIntel } from './intel/publish-intel.mjs';
import { aiConfig } from './intel/classify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'status';
const flag = (name, dflt = undefined) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const [, v] = hit.split('=');
  return v === undefined ? true : v;
};

const DB_PATH = flag('db', DEFAULT_DB);
const DATA_DIR = resolve(ROOT, 'data');
const db = openStore(DB_PATH);
syncSources(db);

const pad = (s, n) => String(s ?? '').padEnd(n);
const line = (k, v) => console.log(`  ${pad(k, 34)}${v}`);

async function main() {
  switch (cmd) {
    case 'sources': {
      console.log(`SOURCES  (${SOURCES.length} declared)\n`);
      for (const s of db.prepare('select * from Source order by trustTier, id').all()) {
        const state = s.requiresConfig ? 'NEEDS CONFIGURATION'
          : s.lastStatus ? `${s.lastStatus}${s.consecutiveFailures ? ` (${s.consecutiveFailures} consecutive failures)` : ''}`
            : 'never run';
        console.log(`  ${pad(s.id, 16)} tier ${s.trustTier}  ${pad(s.sourceType, 20)} ${state}`);
        console.log(`  ${' '.repeat(16)} ${s.feedUrl ?? '(no feed url)'}`);
        if (s.configNote) console.log(`  ${' '.repeat(16)} ! ${s.configNote}`);
        if (s.lastError) console.log(`  ${' '.repeat(16)} last error: ${s.lastError}`);
      }
      break;
    }
    case 'run': {
      const directory = loadDirectory(DATA_DIR);
      if (!directory.available) console.log(`  WARNING entity linking disabled: ${directory.reason}`);
      else line('directory entities loaded', JSON.stringify(directory.counts));
      const ai = aiConfig();
      line('AI provider', ai.available ? `${ai.provider} (${ai.model})` : `none — ${ai.reason}`);
      const out = await runPipeline(db, {
        dataDir: DATA_DIR, directory,
        force: flag('force', false) === true,
        only: flag('only', null),
        dryRun: flag('dry-run', false) === true,
      });
      console.log(`\n  ${out.sources} source(s) due`);
      for (const r of out.results) {
        if (!r.ok) { console.log(`  FAIL  ${pad(r.source, 16)} ${r.error}`); continue; }
        const s = r.stats;
        console.log(`  OK    ${pad(r.source, 16)} HTTP ${r.httpStatus} · seen ${s.seen} · new ${s.added}`
          + ` · updated ${s.updated} · duplicate ${s.duplicate} · medical-review ${s.medical}`);
      }
      break;
    }
    case 'publish': {
      const n = publishReady(db, { limit: Number(flag('limit', 500)) });
      line('promoted READY -> PUBLISHED', n);
      break;
    }
    case 'export': {
      const out = publishIntel(db, { siteBase: String(flag('base', '')) });
      line('articles exported', out.articles);
      line('index pages', out.pages);
      line('categories', JSON.stringify(out.categories));
      break;
    }
    case 'cycle': {
      const directory = loadDirectory(DATA_DIR);
      const out = await runPipeline(db, { dataDir: DATA_DIR, directory, force: flag('force', false) === true });
      for (const r of out.results) {
        console.log(r.ok
          ? `  OK    ${pad(r.source, 16)} new ${r.stats.added} · dup ${r.stats.duplicate}`
          : `  FAIL  ${pad(r.source, 16)} ${r.error}`);
      }
      line('promoted', publishReady(db));
      const ex = publishIntel(db, { siteBase: String(flag('base', '')) });
      line('exported', `${ex.articles} article(s), ${ex.pages} page(s)`);
      break;
    }
    case 'review': {
      const id = flag('id');
      if (!id) { console.error('  --id is required'); process.exitCode = 2; break; }
      const approve = flag('approve', false) === true;
      const reject = flag('reject', false) === true;
      if (approve === reject) { console.error('  pass exactly one of --approve / --reject'); process.exitCode = 2; break; }
      const note = flag('note', null);
      const row = db.prepare('select id, status, medicalReviewStatus from Article where id = ? or slug = ?').get(id, id);
      if (!row) { console.error(`  no article ${id}`); process.exitCode = 2; break; }
      const next = approve ? STATUS.READY : STATUS.REJECTED;
      db.prepare(`update Article set status=?, editorialStatus=?, medicalReviewStatus=?,
        reviewNote=?, updatedAt=? where id=?`)
        .run(next, approve ? 'APPROVED' : 'REJECTED',
          row.medicalReviewStatus === 'PENDING' ? (approve ? 'APPROVED' : 'REJECTED') : row.medicalReviewStatus,
          note, Date.now(), row.id);
      line('article', `${row.id} -> ${next}`);
      break;
    }
    case 'status':
    default: {
      const ai = aiConfig();
      console.log('DOCTORNA INTELLIGENCE\n');
      line('store', DB_PATH);
      line('AI provider', ai.available ? `${ai.provider} (${ai.model})` : `none — ${ai.reason}`);
      const dir = loadDirectory(DATA_DIR);
      line('directory entities', dir.available ? JSON.stringify(dir.counts) : `unavailable (${dir.reason})`);
      console.log('\n  pipeline');
      const rows = db.prepare('select status, count(*) n from Article group by 1 order by 2 desc').all();
      if (!rows.length) console.log('    (no articles ingested yet)');
      for (const r of rows) line(`    ${r.status}`, r.n);
      console.log('\n  sources');
      for (const s of db.prepare('select * from Source order by trustTier, id').all()) {
        line(`    ${s.id}`, s.requiresConfig ? 'NEEDS CONFIGURATION'
          : `${s.lastStatus ?? 'never run'}${s.lastError ? ` — ${s.lastError}` : ''}`);
      }
      break;
    }
  }
}

await main();
db.close();
