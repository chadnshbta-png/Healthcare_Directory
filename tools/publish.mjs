#!/usr/bin/env node
/**
 * Atomically publish a new Healthcare dataset.
 *
 *   generate -> validate -> swap -> record
 *
 * The live `data/` directory is NEVER written in place. A run builds a complete
 * dataset in `data.staging/`, reconciles it against the database, and only then
 * swaps it into place by renaming directories. The previous dataset is kept as
 * `data.previous/` for rollback.
 *
 * The guarantees this buys (CASE F):
 *   - a crash, a failed export or a failed validation leaves `data/` untouched;
 *   - the swap is two renames, so readers see either the old or the new
 *     dataset, never a half-written mixture;
 *   - if the second rename fails the first is undone, so `data/` is restored.
 *
 * Usage:
 *   node tools/publish.mjs --db ../backend/prisma/dev.db
 *   node tools/publish.mjs --db ... --skip-profiles     (skip the 1000 shards)
 *   node tools/publish.mjs --rollback                   (restore data.previous)
 *
 * Exit 0 published (or nothing to do), 1 refused/failed — in both failure cases
 * the live dataset is exactly what it was before the run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const LIVE = resolve(root, 'data');
const STAGING = resolve(root, 'data.staging');
const PREVIOUS = resolve(root, 'data.previous');
const STATUS = 'sync-status.json';

const log = (msg) => console.log(`  ${msg}`);
const stamp = () => new Date().toISOString();

function run(script, scriptArgs) {
  const res = spawnSync(process.execPath, [resolve(here, script), ...scriptArgs], {
    stdio: 'inherit',
    cwd: root,
  });
  return res.status === 0;
}

// ── rollback ────────────────────────────────────────────────────────────────
if (args.rollback) {
  if (!existsSync(PREVIOUS)) {
    console.error('ERROR: no data.previous to roll back to.');
    process.exit(1);
  }
  const scratch = resolve(root, `data.rollback-${Date.now()}`);
  renameSync(LIVE, scratch);
  try {
    renameSync(PREVIOUS, LIVE);
  } catch (err) {
    renameSync(scratch, LIVE); // put it back; never leave the site without data
    console.error(`ERROR: rollback failed, live dataset restored. ${err.message}`);
    process.exit(1);
  }
  renameSync(scratch, PREVIOUS); // the rolled-back-from set becomes "previous"
  log(`rolled back to the previous dataset at ${stamp()}`);
  process.exit(0);
}

if (!args.db) {
  console.error('ERROR: --db <path-to-sqlite> is required.');
  process.exit(2);
}
const dbArg = resolve(process.cwd(), args.db);

console.log(`PUBLISH  ${stamp()}`);
console.log('');

// ── 1. generate into staging ────────────────────────────────────────────────
log('1/4 generate');
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(STAGING, { recursive: true });

if (!run('export-data.mjs', ['--db', dbArg, '--out', 'data.staging'])) {
  console.error('\nFAILED at generate — the live dataset was not touched.');
  process.exit(1);
}

// Profile shards are large and optional; carry the existing ones over unless
// asked to rebuild, so a routine publish need not regenerate 66 MB.
const skipProfiles = args['skip-profiles'] === true || args['skip-profiles'] === 'true';
if (skipProfiles) {
  if (existsSync(resolve(LIVE, 'profiles'))) {
    cpSync(resolve(LIVE, 'profiles'), resolve(STAGING, 'profiles'), { recursive: true });
    log('     carried the existing profile shards over');
  }
} else if (!run('export-profiles.mjs', ['--db', dbArg, '--out', 'data.staging/profiles'])) {
  console.error('\nFAILED at generate (profiles) — the live dataset was not touched.');
  process.exit(1);
}

// ── 2. validate the staged dataset ──────────────────────────────────────────
console.log('');
log('2/4 validate');
if (!run('reconcile.mjs', ['--db', dbArg, '--data', 'data.staging',
  '--json', resolve(STAGING, 'reconciliation.json')])) {
  console.error('\nREFUSED to publish: the staged dataset did not reconcile.');
  console.error(`Inspect ${STAGING} — the live dataset is unchanged.`);
  process.exit(1);
}

// ── 3. swap ─────────────────────────────────────────────────────────────────
console.log('');
log('3/4 swap');
rmSync(PREVIOUS, { recursive: true, force: true });

let movedLive = false;
try {
  if (existsSync(LIVE)) {
    renameSync(LIVE, PREVIOUS);
    movedLive = true;
  }
  renameSync(STAGING, LIVE);
} catch (err) {
  // Put the old dataset back rather than leaving the site with none.
  if (movedLive && !existsSync(LIVE)) renameSync(PREVIOUS, LIVE);
  console.error(`\nFAILED at swap: ${err.message}`);
  console.error('The previous dataset has been restored.');
  process.exit(1);
}
log('     previous dataset kept at data.previous');

// ── 4. record ───────────────────────────────────────────────────────────────
console.log('');
log('4/4 record');
let recon = null;
try { recon = JSON.parse(readFileSync(resolve(LIVE, 'reconciliation.json'), 'utf8')); } catch { /* optional */ }
let meta = null;
try { meta = JSON.parse(readFileSync(resolve(LIVE, 'meta.json'), 'utf8')); } catch { /* optional */ }

const status = {
  lastSuccessfulSyncAt: stamp(),
  schemaVersion: meta?.version ?? null,
  licenceTypeSource: meta?.licenceTypeSource ?? null,
  totals: meta?.totals ?? null,
  exclusions: meta?.exclusions ?? null,
  relationships: meta?.relationships ?? null,
  reconciliation: recon
    ? { ok: recon.ok, failures: recon.checks.filter((c) => c.level === 'FAIL').length,
        notes: recon.checks.filter((c) => c.level === 'NOTE').length }
    : null,
  rollbackAvailable: existsSync(PREVIOUS),
};
writeFileSync(resolve(LIVE, STATUS), JSON.stringify(status, null, 2));
log(`     ${STATUS} written`);

console.log('');
console.log(`PUBLISHED at ${status.lastSuccessfulSyncAt}`);
if (status.totals) {
  console.log(`  doctors ${status.totals.doctors?.toLocaleString?.() ?? status.totals.doctors} · facilities ${status.totals.facilities} · links ${status.totals.doctorFacilityLinks}`);
}
console.log('  roll back with: node tools/publish.mjs --rollback');
