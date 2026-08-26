#!/usr/bin/env node
/**
 * Reconcile a Healthcare export against the ScrapeFlow database.
 *
 * ScrapeFlow is the source of truth. This asks one question of a candidate
 * dataset: does it faithfully represent what the database holds? Every answer
 * is a NUMBER compared against the database, never a spot check.
 *
 * Two kinds of finding:
 *   FAIL   the export misrepresents the source — publishing would ship wrong
 *          data. `publish.mjs` refuses to swap when any FAIL is present.
 *   NOTE   a deliberate, measured exclusion (e.g. professionals whose facility
 *          name never resolved). Recorded so an absence is explainable rather
 *          than mysterious.
 *
 * Usage:
 *   node tools/reconcile.mjs --db ../backend/prisma/dev.db [--data ./data] [--json out.json]
 *
 * Exit code 0 = safe to publish, 1 = do not publish.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

if (!args.db) {
  console.error('ERROR: --db <path-to-sqlite> is required.');
  process.exit(2);
}
const dbPath = resolve(process.cwd(), args.db);
const dataDir = resolve(here, '..', typeof args.data === 'string' ? args.data : 'data');

const read = (f) => JSON.parse(readFileSync(resolve(dataDir, f), 'utf8'));

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, level: ok ? 'PASS' : 'FAIL', detail }); return ok; };
const note = (name, detail) => { checks.push({ name, level: 'NOTE', detail }); };

for (const f of ['meta.json', 'facets.json', 'doctors.json', 'facilities.json']) {
  if (!existsSync(resolve(dataDir, f))) {
    console.error(`ERROR: ${f} missing from ${dataDir}`);
    process.exit(2);
  }
}

const meta = read('meta.json');
const facets = read('facets.json');
const doctors = read('doctors.json');
const facilities = read('facilities.json');

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql) => db.prepare(sql).get();
const all = (sql) => db.prepare(sql).all();

// ── the source, measured ────────────────────────────────────────────────────
const src = {
  doctors: one('select count(*) c from Doctor').c,
  facilities: one('select count(*) c from Facility').c,
  relationships: one('select count(*) c from DoctorFacility').c,
  currentRelationships: one(`
    select count(*) c from DoctorFacility
    where isCurrent = 1 or relationType in ('current_license','search_stage')`).c,
  distinctCurrentPairs: one(`
    select count(*) c from (
      select distinct doctorId, facilityId from DoctorFacility
      where isCurrent = 1 or relationType in ('current_license','search_stage'))`).c,
  licenceRows: one('select count(*) c from DoctorLicenceType').c,
  licenceByType: all('select licenceType, count(*) n from DoctorLicenceType group by 1'),
  doctorsWithNoCurrentRel: one(`
    select count(*) c from Doctor d where not exists (
      select 1 from DoctorFacility f
      where f.doctorId = d.id
        and (f.isCurrent = 1 or f.relationType in ('current_license','search_stage')))`).c,
  duplicateRelationships: one(`
    select count(*) c from (
      select doctorId, facilityId, sourceSection, sourceHash, count(*) n
      from DoctorFacility group by 1,2,3,4 having n > 1)`).c,
  orphanRelationships: one(`
    select count(*) c from DoctorFacility df
    where not exists (select 1 from Doctor d where d.id = df.doctorId)
       or not exists (select 1 from Facility f where f.id = df.facilityId)`).c,
  collapsedStillStored: one("select count(*) c from Doctor where specialities like '%Show All%'").c,
};

// ── the export, measured ────────────────────────────────────────────────────
const R = { ID: 0, NAME: 1, LICENCE: 4, FACILITY: 6 };
const rows = doctors.rows ?? [];
const arr = (v) => (Array.isArray(v) ? v : typeof v === 'number' && v >= 0 ? [v] : []);

let exportedPairs = 0;
let doctorsWithNoFacility = 0;
let doctorsMultiFacility = 0;
let maxFacilities = 0;
let doctorsMultiLicence = 0;
const licenceCounts = new Map();
const idSeen = new Set();
let duplicateIds = 0;

for (const r of rows) {
  if (idSeen.has(r[R.ID])) duplicateIds++;
  idSeen.add(r[R.ID]);

  const fac = arr(r[R.FACILITY]);
  if (new Set(fac).size !== fac.length) doctorsMultiFacility += 0; // duplicates checked below
  exportedPairs += new Set(fac).size;
  if (fac.length === 0) doctorsWithNoFacility++;
  if (fac.length > 1) doctorsMultiFacility++;
  if (fac.length > maxFacilities) maxFacilities = fac.length;

  const lic = arr(r[R.LICENCE]);
  if (lic.length > 1) doctorsMultiLicence++;
  for (const i of new Set(lic)) licenceCounts.set(i, (licenceCounts.get(i) ?? 0) + 1);
}

const dupFacilityRefs = rows.filter((r) => {
  const f = arr(r[R.FACILITY]);
  return new Set(f).size !== f.length;
}).length;

// ── the comparisons ─────────────────────────────────────────────────────────
check('doctor count matches the source', rows.length === src.doctors,
  `export ${rows.length} vs db ${src.doctors}`);
check('meta.totals.doctors agrees with the rows', meta.totals?.doctors === rows.length,
  `meta ${meta.totals?.doctors} vs rows ${rows.length}`);
check('facility count matches the source', (facilities.facilities ?? []).length === src.facilities,
  `export ${(facilities.facilities ?? []).length} vs db ${src.facilities}`);
check('no duplicate doctor ids in the export', duplicateIds === 0, `${duplicateIds} duplicates`);
check('no doctor references the same facility twice', dupFacilityRefs === 0,
  `${dupFacilityRefs} doctors`);
check('no orphan relationships in the source', src.orphanRelationships === 0,
  `${src.orphanRelationships} rows point at a missing doctor or facility`);
check('no duplicate relationships in the source', src.duplicateRelationships === 0,
  `${src.duplicateRelationships} duplicate identity keys`);

// Current doctor↔facility pairs must survive the export exactly.
check('every current doctor-facility pair is exported',
  exportedPairs === src.distinctCurrentPairs,
  `export ${exportedPairs} vs db ${src.distinctCurrentPairs}`);

// Multi-facility must actually be represented.
check('multi-facility doctors are present', doctorsMultiFacility > 0,
  `${doctorsMultiFacility} doctors with 2+ facilities, max ${maxFacilities}`);

// Licence types: the facet must be multi-valued and match the source per bucket.
const dictLic = facets.dict?.licenseType ?? [];
const facetLic = new Map((facets.facets?.licenseType ?? []).map((x) => [x.label, x.count]));
let licenceMismatch = 0;
const licenceDetail = [];
for (const { licenceType, n } of src.licenceByType) {
  const got = facetLic.get(licenceType) ?? 0;
  licenceDetail.push(`${licenceType}: export ${got} vs db ${n}`);
  if (got !== n) licenceMismatch++;
}
check('every licence-type facet matches the source', licenceMismatch === 0, licenceDetail.join(' | '));
check('licence type is modelled as a set', meta.version >= 3,
  `schema v${meta.version} (v3 introduced the licence-type array)`);

if (src.licenceRows === 0) {
  note('licence-type membership is empty', 'DoctorLicenceType has no rows — run scripts/sync-licence-types.mjs --crawl');
}
// Membership seeded from the PRIMARY scalar is a placeholder, not an answer:
// it records one type per doctor, so every bucket but the largest undercounts
// (Part-time read 32 against the register's ~3,684). Publishing that silently
// would look like a working facet and be wrong, so it FAILS by default.
// `--allow-primary-licences` exists for a deliberate offline publish.
const allowPrimary = args['allow-primary-licences'] === true || args['allow-primary-licences'] === 'true';
const primarySeeded = one(
  "select count(*) c from DoctorLicenceType where source = 'primary_dto'",
).c;
const filterPassed = one(
  "select count(*) c from DoctorLicenceType where source = 'filter_pass'",
).c;

// The question is whether an authoritative pass has EVER run — not whether any
// placeholder rows survive. A professional the register no longer returns keeps
// their old row forever (retention, CASE G), so demanding zero placeholders
// would block publishing permanently.
if (filterPassed === 0) {
  const msg = `no membership row came from a filter pass (${primarySeeded} are placeholder) — run scripts/sync-licence-types.mjs --crawl`;
  if (allowPrimary) note('licence membership is placeholder data', msg);
  else check('licence membership is authoritative', false, msg);
} else if (primarySeeded > 0) {
  note('residual placeholder membership',
    `${primarySeeded} rows still from the primary scalar vs ${filterPassed} from a filter pass — professionals the latest passes did not return`);
}
if (meta.licenceTypeSource && meta.licenceTypeSource !== 'doctor_licence_type') {
  note('licence facet built from the exporter fallback',
    `meta.licenceTypeSource="${meta.licenceTypeSource}"`);
}

// ── facility type: every facility is classified ─────────────────────────────
// DHA publishes no facility type, so the directory derives one. The contract is
// that EVERY facility gets an answer: a record with no type reaches the UI as a
// non-category ("Type not published"), which is a defect, not a value.
{
  const list = facilities.facilities ?? [];
  const untyped = list.filter((f) => !f.type);
  const unclassified = list.filter((f) => f.type === 'other');
  const bySource = new Map();
  const byType = new Map();
  for (const f of list) {
    bySource.set(f.typeSource ?? 'none', (bySource.get(f.typeSource ?? 'none') ?? 0) + 1);
    byType.set(f.type ?? 'none', (byType.get(f.type ?? 'none') ?? 0) + 1);
  }

  check('every facility carries a classified type', untyped.length === 0,
    `${untyped.length} of ${list.length} have no type${untyped.length ? ` — e.g. ${untyped.slice(0, 3).map((f) => f.name).join(' | ')}` : ''}`);
  check('no facility falls back to the unclassified bucket', unclassified.length === 0,
    `${unclassified.length} classified as "other"${unclassified.length ? ` — e.g. ${unclassified.slice(0, 3).map((f) => f.name).join(' | ')}` : ''}`);

  // The classification must not be DHA's guess wearing a new label: the name
  // rules and the staff inference have to be doing the work.
  const fromDha = bySource.get('dha_type') ?? 0;
  check('classification is not merely the DHA guess', fromDha < list.length,
    `${fromDha} of ${list.length} fell through to the DHA keyword read`);

  // Every type present on a facility must be a type the facet can offer, or a
  // filter could never reach those facilities.
  const facetTypes = new Set((facets.facets?.facilityType ?? []).map((x) => x.label));
  const withDoctors = new Set(list.filter((f) => f.doctorCount > 0).map((f) => f.type));
  const missing = [...withDoctors].filter((t) => facetTypes.size > 0 && !facetTypes.has(t));
  if (facetTypes.size === 0) {
    // facets.facilityType is derived in the browser from facilities.json, so an
    // export that does not precompute it is expected, not broken.
    note('facility-type facet is derived at load time',
      `${withDoctors.size} distinct types across facilities with professionals`);
  } else {
    check('every staffed facility type is offered by the facet', missing.length === 0,
      missing.join(', ') || 'all present');
  }

  note('facility types in the export',
    [...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' · '));
  note('facility type source',
    [...bySource].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(' · '));
}

// ── repeated profile sections survive the export ────────────────────────────
// The profile export is optional, so its absence is a NOTE. When it IS present
// its entry counts are compared against the register's own, which is what
// proves no repeated section was de-duplicated or collapsed on the way out.
{
  const indexPath = resolve(dataDir, 'profiles', 'index.json');
  if (!existsSync(indexPath)) {
    note('profile shards not in this dataset', 'education and work history are reported by flag only');
  } else {
    const pindex = JSON.parse(readFileSync(indexPath, 'utf8'));

    /** Entries the register published, counted straight off the source text. */
    const countEntries = (column) => {
      let docs = 0;
      let entries = 0;
      for (const r of db.prepare(`select ${column} v from Doctor where ${column} is not null and ${column} != ''`).iterate()) {
        docs++;
        for (const part of String(r.v).split(' | ')) if (part.trim()) entries++;
      }
      return { docs, entries };
    };
    const srcEdu = countEntries('education');
    const srcWork = countEntries('experience');

    check('every education record is exported',
      pindex.entries?.education === srcEdu.entries,
      `export ${pindex.entries?.education ?? 'absent'} vs source ${srcEdu.entries}`);
    check('every professional with education has a profile record',
      pindex.counts?.withEducation === srcEdu.docs,
      `export ${pindex.counts?.withEducation ?? 'absent'} vs source ${srcEdu.docs}`);
    check('every work-history record is exported',
      pindex.entries?.work === srcWork.entries,
      `export ${pindex.entries?.work ?? 'absent'} vs source ${srcWork.entries}`);
    note('repeated sections exported',
      `education ${srcEdu.entries} entries across ${srcEdu.docs} professionals · work ${srcWork.entries} across ${srcWork.docs}`);
  }
}

// ── measured exclusions ─────────────────────────────────────────────────────
note('professionals with no current facility',
  `${doctorsWithNoFacility} in the export / ${src.doctorsWithNoCurrentRel} in the source — facility name absent or unresolvable`);
check('the export agrees with the source on who has no facility',
  doctorsWithNoFacility === src.doctorsWithNoCurrentRel,
  `export ${doctorsWithNoFacility} vs db ${src.doctorsWithNoCurrentRel}`);
// `Doctor.specialities` keeps the flattened text the OLD parser produced, so a
// collapsed string there is not evidence the facilities are missing — the
// backfill recovers the RELATIONSHIPS without rewriting that column. What
// matters is whether those professionals actually have relationships now.
if (src.collapsedStillStored > 0) {
  const recovered = one(`
    select count(*) c from Doctor d
    where d.specialities like '%Show All%'
      and exists (select 1 from DoctorFacility f
                  where f.doctorId = d.id and f.sourceSection = 'specialities')`).c;
  const outstanding = src.collapsedStillStored - recovered;
  if (outstanding > 0) {
    note('collapsed lists not yet expanded',
      `${outstanding} of ${src.collapsedStillStored} profiles have no expanded relationships — run scripts/backfill-collapsed-facilities.mjs`);
  } else {
    note('collapsed source text retained',
      `${src.collapsedStillStored} profiles keep the old flattened text, but all have expanded relationships`);
  }
}
note('relationship rows by kind',
  `total ${src.relationships}, current ${src.currentRelationships}, distinct current pairs ${src.distinctCurrentPairs}`);
note('multi-licence doctors in the export', String(doctorsMultiLicence));

db.close();

// ── report ──────────────────────────────────────────────────────────────────
const failures = checks.filter((c) => c.level === 'FAIL');
const report = {
  generatedAt: new Date().toISOString(),
  dataDir,
  dbPath,
  ok: failures.length === 0,
  source: src,
  export: {
    doctors: rows.length,
    facilities: (facilities.facilities ?? []).length,
    currentPairs: exportedPairs,
    doctorsWithNoFacility,
    doctorsMultiFacility,
    maxFacilitiesPerDoctor: maxFacilities,
    doctorsMultiLicence,
    schemaVersion: meta.version,
    licenceTypeSource: meta.licenceTypeSource ?? null,
    licenceFacet: Object.fromEntries(facetLic),
  },
  checks,
};

const pad = (s, n) => String(s).padEnd(n);
console.log(`RECONCILIATION  ${dataDir}`);
console.log('');
for (const c of checks) {
  const tag = c.level === 'PASS' ? 'PASS' : c.level === 'FAIL' ? 'FAIL' : 'NOTE';
  console.log(`  ${tag}  ${pad(c.name, 52)} ${c.detail ?? ''}`);
}
console.log('');
console.log(`  ${failures.length === 0 ? 'RECONCILED — safe to publish' : `${failures.length} FAILURE(S) — do not publish`}`);

if (typeof args.json === 'string') {
  writeFileSync(resolve(process.cwd(), args.json), JSON.stringify(report, null, 2));
  console.log(`  report written to ${args.json}`);
}

process.exit(failures.length === 0 ? 0 : 1);
