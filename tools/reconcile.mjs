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

import { lifecycle } from './lifecycle.mjs';
import { licenceNamesFor } from './licence-set.mjs';

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

// ── the population under comparison ─────────────────────────────────────────
// The exporter publishes the ACTIVE register (tools/lifecycle.mjs). Every
// source figure below is therefore measured over the SAME set: comparing an
// active-only export against an all-time source count would fail every check
// for the right dataset, and — far worse — a source count that quietly included
// de-listed professionals would PASS an export that had included them too.
// Both tools import the one definition so they cannot drift apart.
const life = lifecycle(db);
const ACTIVE_D = life.doctor('d');
const activeVia = (alias) => life.viaDoctorId(alias);

// ── the source, measured ────────────────────────────────────────────────────
const src = {
  doctors: one(`select count(*) c from Doctor d where ${ACTIVE_D}`).c,
  allTimeDoctors: life.totalDoctors,
  removedDoctors: life.removedDoctors,
  facilities: one('select count(*) c from Facility').c,
  relationships: one(`select count(*) c from DoctorFacility df where ${activeVia('df')}`).c,
  currentRelationships: one(`
    select count(*) c from DoctorFacility df
    where (df.isCurrent = 1 or df.relationType in ('current_license','search_stage'))
      and ${activeVia('df')}`).c,
  distinctCurrentPairs: one(`
    select count(*) c from (
      select distinct df.doctorId, df.facilityId from DoctorFacility df
      where (df.isCurrent = 1 or df.relationType in ('current_license','search_stage'))
        and ${activeVia('df')})`).c,
  licenceRows: one(`select count(*) c from DoctorLicenceType t where ${activeVia('t')}`).c,
  licenceByType: all(`select t.licenceType, count(*) n from DoctorLicenceType t
    where ${activeVia('t')} group by 1`),
  doctorsWithNoCurrentRel: one(`
    select count(*) c from Doctor d where ${ACTIVE_D} and not exists (
      select 1 from DoctorFacility f
      where f.doctorId = d.id
        and (f.isCurrent = 1 or f.relationType in ('current_license','search_stage')))`).c,
  duplicateRelationships: one(`
    select count(*) c from (
      select df.doctorId, df.facilityId, df.sourceSection, df.sourceHash, count(*) n
      from DoctorFacility df where ${activeVia('df')} group by 1,2,3,4 having n > 1)`).c,
  orphanRelationships: one(`
    select count(*) c from DoctorFacility df
    where not exists (select 1 from Doctor d where d.id = df.doctorId)
       or not exists (select 1 from Facility f where f.id = df.facilityId)`).c,
  collapsedStillStored: one(`select count(*) c from Doctor d
    where ${ACTIVE_D} and d.specialities like '%Show All%'`).c,
};

// ── the export, measured ────────────────────────────────────────────────────
const R = { ID: 0, NAME: 1, SPECIALTY: 3, LICENCE: 4, FACILITY: 6, PRIMARY: 10, ROLES: 11 };
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

// ── lifecycle: the export is the ACTIVE register, and only that ─────────────
// A de-listed professional keeps their Doctor row, their relationships, their
// licences and their profile in ScrapeFlow. None of it may be published. These
// checks are set-level rather than count-level on purpose: two populations can
// agree on size and still be different people.
{
  const exportedIds = new Set(rows.map((r) => String(r[R.ID])));
  const removedIds = new Set(
    all(`select dhaUniqueId from Doctor where removedAt is not null`).map((r) => String(r.dhaUniqueId)),
  );
  const activeIds = new Set(
    all(`select d.dhaUniqueId from Doctor d where ${ACTIVE_D}`).map((r) => String(r.dhaUniqueId)),
  );

  let leaked = 0;
  const leakSample = [];
  for (const id of exportedIds) {
    if (removedIds.has(id)) { leaked++; if (leakSample.length < 3) leakSample.push(id); }
  }
  check('no de-listed professional is published as active', leaked === 0,
    leaked ? `${leaked} removed ids in the export, e.g. ${leakSample.join(', ')}` :
      `${removedIds.size} removed professionals, none exported`);

  let missing = 0, invented = 0;
  for (const id of activeIds) if (!exportedIds.has(id)) missing++;
  for (const id of exportedIds) if (!activeIds.has(id)) invented++;
  check('every active professional is exported', missing === 0, `${missing} missing from the export`);
  check('the export invents no professional', invented === 0,
    `${invented} exported ids are in no active source row`);

  check('meta records the lifecycle it filtered on',
    meta.lifecycle?.source === life.source && meta.lifecycle?.activeDoctors === src.doctors,
    `meta.lifecycle=${JSON.stringify(meta.lifecycle ?? null)} vs source active ${src.doctors}`);
  check('meta.exclusions counts the removed set',
    meta.exclusions?.removedProfessionals === src.removedDoctors,
    `meta ${meta.exclusions?.removedProfessionals} vs db ${src.removedDoctors}`);
  note('register lifecycle',
    `${src.doctors} active of ${src.allTimeDoctors} Doctor rows · ${src.removedDoctors} de-listed and withheld`);
}

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
//
// The expected facet is rebuilt PER PROFESSIONAL through the same function the
// exporter uses (tools/licence-set.mjs), not read straight off DoctorLicenceType.
// The two differ whenever the membership pass has not reached someone: a
// professional registered since the last pass has no rows, and the export
// publishes the licence type DHA does hold for them rather than none. Comparing
// against the raw join table would fail that correct export — and, worse, would
// pass an export that had invented memberships for professionals who DO have
// rows. Rebuilding the same way compares like with like, and still catches a
// bucket the export got wrong for anybody.
const dictLic = facets.dict?.licenseType ?? [];
const facetLic = new Map((facets.facets?.licenseType ?? []).map((x) => [x.label, x.count]));
let licenceMismatch = 0;
let licenceFallbackDoctors = 0;
const licenceDetail = [];
{
  const membership = new Map();
  for (const l of db.prepare(`select t.doctorId, t.licenceType from DoctorLicenceType t
    where ${activeVia('t')}`).iterate()) {
    let list = membership.get(l.doctorId);
    if (!list) membership.set(l.doctorId, (list = []));
    if (!list.includes(l.licenceType)) list.push(l.licenceType);
  }
  const expected = new Map();
  for (const d of db.prepare(`select d.id, d.licenseType from Doctor d where ${ACTIVE_D}`).iterate()) {
    const held = membership.get(d.id);
    const names = licenceNamesFor(held, d.licenseType);
    if (!held && names.length > 0) licenceFallbackDoctors++;
    for (const n of names) expected.set(n, (expected.get(n) ?? 0) + 1);
  }
  for (const [label, n] of [...expected].sort((a, b) => b[1] - a[1])) {
    const got = facetLic.get(label) ?? 0;
    licenceDetail.push(`${label}: export ${got} vs source ${n}`);
    if (got !== n) licenceMismatch++;
  }
  // A label the export publishes that the source never produces is a fabrication.
  for (const [label, got] of facetLic) {
    if (!expected.has(label)) { licenceMismatch++; licenceDetail.push(`${label}: export ${got} vs source 0`); }
  }
}
check('every licence-type facet matches the source', licenceMismatch === 0, licenceDetail.join(' | '));
check('meta reports how many professionals used the licence fallback',
  meta.licenceTypeFallbackDoctors === licenceFallbackDoctors,
  `meta ${meta.licenceTypeFallbackDoctors} vs source ${licenceFallbackDoctors}`);
if (licenceFallbackDoctors > 0) {
  note('licence types taken from the primary scalar',
    `${licenceFallbackDoctors} professionals have no DoctorLicenceType row — they hold the single ` +
    `type the search DTO publishes. Run scripts/sync-licence-types.mjs --crawl to give them the full set.`);
}
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

// ── DHA-aligned primary facility counts ─────────────────────────────────────
// `primaryCount` must equal the register's own `search_stage` relationship for
// that facility, counted per distinct doctor. This is the figure the directory
// publishes as "registered professionals", so it has to be exactly the source's
// primary relationship and nothing else.
{
  const list = facilities.facilities ?? [];
  const srcPrimary = new Map(all(`
    select f.id id, count(distinct df.doctorId) n
    from DoctorFacility df join Facility f on f.id = df.facilityId
    where df.relationType = 'search_stage' and ${activeVia('df')} group by 1`).map((r) => [r.id, r.n]));

  let missingField = 0, mismatch = 0, over = 0;
  const detail = [];
  for (const f of list) {
    if (typeof f.primaryCount !== 'number') { missingField++; continue; }
    const want = srcPrimary.get(f.id) ?? 0;
    if (f.primaryCount !== want) {
      mismatch++;
      if (detail.length < 3) detail.push(`${f.name}: export ${f.primaryCount} vs db ${want}`);
    }
    // A primary link is also a current link, so this can never exceed it.
    if (f.primaryCount > f.doctorCount) over++;
  }
  check('every facility carries a primaryCount', missingField === 0, `${missingField} without the field`);
  check('primaryCount matches the source search_stage relationship',
    mismatch === 0, mismatch ? detail.join(' | ') : 'all facilities agree');
  check('primaryCount never exceeds the all-linked count', over === 0, `${over} facilities`);

  // Referential integrity of slot 10, checked against the published arrays
  // rather than the database: a primary index that points outside facilities[]
  // or at a facility the professional is not currently linked to would render
  // as the wrong employer or crash the detail page.
  let outOfRange = 0, notAlsoCurrent = 0;
  for (const r of rows) {
    const cur = new Set(arr(r[R.FACILITY]));
    for (const i of arr(r[10])) {
      if (!(i >= 0 && i < list.length)) outOfRange++;
      else if (!cur.has(i)) notAlsoCurrent++;
    }
  }
  check('every primaryFacilityIdx points at an exported facility', outOfRange === 0,
    `${outOfRange} out-of-range indexes`);
  check('every primary facility is also one of the current facilities', notAlsoCurrent === 0,
    `${notAlsoCurrent} primary links absent from the all-linked set`);

  const sumPrimary = list.reduce((s, f) => s + (f.primaryCount ?? 0), 0);
  const srcPairs = one(`select count(*) c from (
    select distinct df.doctorId, df.facilityId from DoctorFacility df
    where df.relationType='search_stage' and ${activeVia('df')})`).c;
  check('every primary doctor-facility pair is exported', sumPrimary === srcPairs,
    `export ${sumPrimary} vs db ${srcPairs}`);
  note('primary vs all-linked totals',
    `${sumPrimary} primary pairs across ${list.filter((f) => f.primaryCount > 0).length} facilities, ` +
    `vs ${list.reduce((s, f) => s + f.doctorCount, 0)} all-linked pairs`);
}

// ── every current licence's facility survives, exactly once ─────────────────
// A professional's "Current licences" section can name the SAME facility on
// several rows and DIFFERENT facilities on others. The relationship set must be
// UNIQUE(professional, facility) over ALL of those rows — never "the first
// licence wins", and never one relationship per licence row.
//
// This is checked as a SET, not as a total: the pair-count check above would
// still pass if one facility were dropped and another gained, which is exactly
// the shape a "took the first licence and stopped" regression would have.
{
  const list = facilities.facilities ?? [];
  const facIdxById = new Map(list.map((f, i) => [f.id, i]));
  const licPairs = new Map();       // every current licence
  const activePairs = new Map();    // ACTIVE licences only
  let licRows = 0, activeRows = 0;
  for (const l of db.prepare(`
    select d.dhaUniqueId id, df.facilityId fid, df.statusLabel st
    from DoctorFacility df join Doctor d on d.id = df.doctorId
    where ${ACTIVE_D} and df.relationType = 'current_license'`).iterate()) {
    licRows++;
    const fi = facIdxById.get(l.fid);
    if (fi === undefined) continue;
    const key = String(l.id);
    let s = licPairs.get(key);
    if (!s) licPairs.set(key, (s = new Set()));
    s.add(fi);
    if (l.st === 'Active License') {
      activeRows++;
      let a = activePairs.get(key);
      if (!a) activePairs.set(key, (a = new Set()));
      a.add(fi);
    }
  }

  let missing = 0, dupInRow = 0, uniquePairs = 0;
  const detail = [];
  for (const r of rows) {
    const linked = arr(r[R.FACILITY]);
    const set = new Set(linked);
    if (set.size !== linked.length) {
      dupInRow++;
      if (detail.length < 3) detail.push(`${r[R.ID]} lists a facility twice`);
    }
    const want = licPairs.get(String(r[R.ID]));
    if (!want) continue;
    uniquePairs += want.size;
    for (const fi of want) {
      if (!set.has(fi)) {
        missing++;
        if (detail.length < 6) detail.push(`${r[R.ID]} is licensed at ${list[fi]?.name} but the export omits it`);
      }
    }
  }
  // The narrower, explicitly-stated contract: an ACTIVE licence at a facility
  // must always produce an all-linked relationship. Checked separately from the
  // set above so the guarantee is legible on its own rather than implied by a
  // superset passing.
  let activeMissing = 0, activePairCount = 0;
  const activeDetail = [];
  for (const r of rows) {
    const set = new Set(arr(r[R.FACILITY]));
    const want = activePairs.get(String(r[R.ID]));
    if (!want) continue;
    activePairCount += want.size;
    for (const fi of want) {
      if (!set.has(fi)) {
        activeMissing++;
        if (activeDetail.length < 3) {
          activeDetail.push(`${r[R.ID]} holds an active licence at ${list[fi]?.name}, absent from all-linked`);
        }
      }
    }
  }
  check('every ACTIVE-licence facility appears in the all-linked set',
    activeMissing === 0,
    activeMissing ? activeDetail.join(' | ') : `${activePairCount} active-licence pairs, none missing`);

  // ── slot 12 IS the corroborated workplace set, exactly ───────────────────
  // Rebuilt here from the source independently of the exporter: an active
  // licence covering the facility, AND the register naming it directly — on
  // the licence itself (before "and N others"), in a "(Present)" experience
  // record, or in the search DTO. Facilities that appear only under DHA's
  // "Other Facilities" disclosure are premises a licence covers, not places
  // the professional works, and must not reach a staff list.
  //
  // Checked in BOTH directions: a missing entry hides someone who works there,
  // an extra entry staffs a facility with someone who does not.
  const facKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const presentPairs = new Map(), namedText = new Map();
  for (const l of db.prepare(`select d.dhaUniqueId id, df.facilityId fid
    from DoctorFacility df join Doctor d on d.id = df.doctorId
    where ${ACTIVE_D} and df.relationType='employment_history' and df.isCurrent=1`).iterate()) {
    const fi = facIdxById.get(l.fid);
    if (fi === undefined) continue;
    let s = presentPairs.get(String(l.id));
    if (!s) presentPairs.set(String(l.id), (s = new Set()));
    s.add(fi);
  }
  for (const d of db.prepare(`select d.dhaUniqueId id, d.specialities s from Doctor d
    where ${ACTIVE_D} and d.specialities is not null and d.specialities != ''`).iterate()) {
    const set = new Set();
    for (const entry of String(d.s).split(' | ')) {
      const parts = entry.split(' · ');
      if (parts.length < 2) continue;
      let printed = parts[1].trim();
      const collapsed = /^(.*?)\s+and\s+\d+\s+others?\b/i.exec(printed);
      if (collapsed) printed = collapsed[1].trim();
      printed = printed.replace(/\s*Show All\s*$/i, '').trim();
      if (printed) set.add(facKey(printed));
    }
    namedText.set(String(d.id), set);
  }
  const primaryOf = new Map();
  for (const r of rows) primaryOf.set(String(r[R.ID]), new Set(arr(r[R.PRIMARY])));

  const workplacePairs = new Map();
  for (const [id, licensed] of activePairs) {
    const named = namedText.get(id) ?? new Set();
    const present = presentPairs.get(id) ?? new Set();
    const prim = primaryOf.get(id) ?? new Set();
    const keep = new Set();
    for (const fi of licensed) {
      if (named.has(facKey(list[fi]?.name)) || present.has(fi) || prim.has(fi)) keep.add(fi);
    }
    if (keep.size) workplacePairs.set(id, keep);
  }

  let slotMissing = 0, slotExtra = 0, slotDup = 0, slotPairs = 0;
  const slotDetail = [];
  for (const r of rows) {
    const want = workplacePairs.get(String(r[R.ID])) ?? new Set();
    const raw = r[12];
    const got = Array.isArray(raw) ? raw : (typeof raw === 'number' && raw >= 0 ? [raw] : []);
    const gotSet = new Set(got);
    if (gotSet.size !== got.length) slotDup++;
    slotPairs += gotSet.size;
    for (const fi of want) {
      if (!gotSet.has(fi)) {
        slotMissing++;
        if (slotDetail.length < 3) slotDetail.push(`${r[R.ID]} works at ${list[fi]?.name}, absent from slot 12`);
      }
    }
    for (const fi of gotSet) {
      if (!want.has(fi)) {
        slotExtra++;
        if (slotDetail.length < 6) slotDetail.push(`${r[R.ID]} staffed at ${list[fi]?.name} with no corroboration`);
      }
    }
  }
  check('the facility-staff population is exactly the corroborated workplace set',
    slotMissing === 0 && slotExtra === 0,
    slotMissing || slotExtra
      ? `${slotMissing} missing, ${slotExtra} unexpected — ${slotDetail.slice(0, 3).join(' | ')}`
      : `${slotPairs} pairs, no missing and no unexpected relationship`);
  check('no professional is staffed at the same facility twice', slotDup === 0, `${slotDup} rows`);
  {
    let licPairs = 0; for (const s of activePairs.values()) licPairs += s.size;
    note('licence coverage vs workplace',
      `${licPairs} active-licence pairs, of which ${slotPairs} are corroborated as workplaces; ` +
      `the other ${licPairs - slotPairs} are facilities a licence covers ("Other Facilities") and stay in all-linked`);
  }

  // Facility staff counts must be derived from that same set.
  {
    const per = new Map();
    for (const r of rows) {
      const raw = r[12];
      const got = Array.isArray(raw) ? raw : (typeof raw === 'number' && raw >= 0 ? [raw] : []);
      for (const fi of new Set(got)) per.set(fi, (per.get(fi) ?? 0) + 1);
    }
    let bad = 0, over = 0;
    const badDetail = [];
    for (let i = 0; i < list.length; i++) {
      const want = per.get(i) ?? 0;
      if (list[i].licensedCount !== want) {
        bad++;
        if (badDetail.length < 3) badDetail.push(`${list[i].name}: field ${list[i].licensedCount} vs rows ${want}`);
      }
      if (list[i].licensedCount > list[i].doctorCount) over++;
    }
    check('every facility carries a licensedCount matching its listed people',
      bad === 0, bad ? badDetail.join(' | ') : `${list.length} facilities agree`);
    check('licensedCount never exceeds the all-linked count', over === 0, `${over} facilities`);
    note('facility staff vs the other populations',
      `${slotPairs} licensed pairs · ${list.reduce((s, f) => s + (f.primaryCount ?? 0), 0)} primary · ` +
      `${list.reduce((s, f) => s + f.doctorCount, 0)} all-linked`);
  }
  check('every current-licence facility survives into the all-linked set',
    missing === 0, missing ? detail.slice(0, 3).join(' | ') : `${uniquePairs} licensed pairs, none dropped`);
  check('no professional lists the same facility twice', dupInRow === 0,
    `${dupInRow} rows with a repeated facility`);
  note('current licences collapsed to relationships',
    `${licRows} licence rows (${activeRows} active) -> ${uniquePairs} unique (professional, facility) pairs ` +
    `across ${licPairs.size} professionals`);
  if (uniquePairs > activePairCount) {
    note('relationships resting on a non-active current licence',
      `${uniquePairs - activePairCount} pairs come from a licence the register does not label ` +
      `"Active License". They are retained: DHA lists them under Current licences, and dropping ` +
      `them would remove a relationship the source still publishes.`);
  }
}

// ── per-facility roles (slot 11) ────────────────────────────────────────────
// The register issues a licence per facility and prints a role on each. Slot 11
// carries that role wherever it differs from the professional-level specialty.
// Every override is checked against the source, in BOTH directions: an override
// the database does not support would be an invented specialty at a facility,
// and a missing one would put the professional's other specialty on a facility
// the register never associated it with.
{
  const list = facilities.facilities ?? [];
  const specDict = facets.dict?.specialty ?? [];
  const facIdxById = new Map(list.map((f, i) => [f.id, i]));
  const nameOfFacIdx = list.map((f) => f.name);

  // Source truth: (doctor, facility) -> set of current-licence titles.
  const srcTitles = new Map();
  for (const l of db.prepare(`
    select d.dhaUniqueId id, df.facilityId, df.title
    from DoctorFacility df
    join Doctor d on d.id = df.doctorId
    join Facility f on f.id = df.facilityId
    where ${ACTIVE_D} and df.relationType = 'current_license'
      and df.title is not null and trim(df.title) != ''`).iterate()) {
    const fi = facIdxById.get(l.facilityId);
    if (fi === undefined) continue;
    const key = `${l.id}${fi}`;
    let s = srcTitles.get(key);
    if (!s) srcTitles.set(key, (s = new Set()));
    s.add(String(l.title).replace(/\s+/g, ' ').trim());
  }

  let overrides = 0, unsupported = 0, missing = 0, badIdx = 0, notLinked = 0;
  const detail = [];
  for (const r of rows) {
    const id = String(r[R.ID]);
    const linked = new Set(arr(r[R.FACILITY]));
    const own = r[R.SPECIALTY] >= 0 ? specDict[r[R.SPECIALTY]] : '';
    const seen = new Set();
    for (const entry of (Array.isArray(r[11]) ? r[11] : [])) {
      overrides++;
      const fi = entry[0];
      seen.add(fi);
      if (!(fi >= 0 && fi < list.length)) { badIdx++; continue; }
      if (!linked.has(fi)) { notLinked++; continue; }
      const want = srcTitles.get(`${id}${fi}`);
      const got = new Set(entry.slice(1).map((i) => specDict[i]));
      const same = want && want.size === got.size && [...got].every((x) => want.has(x));
      if (!same) {
        unsupported++;
        if (detail.length < 3) {
          detail.push(`${id} @ ${nameOfFacIdx[fi]}: export [${[...got].join('/')}] vs db [${want ? [...want].join('/') : 'none'}]`);
        }
      }
    }
    // Every (doctor, facility) whose source titles are NOT exactly the
    // professional's own specialty must carry an override.
    for (const fi of linked) {
      if (seen.has(fi)) continue;
      const want = srcTitles.get(`${id}${fi}`);
      if (!want || want.size === 0) continue;
      if (want.size === 1 && want.has(own)) continue;
      missing++;
      if (detail.length < 6) {
        detail.push(`MISSING ${id} @ ${nameOfFacIdx[fi]}: db says [${[...want].join('/')}], own "${own}"`);
      }
    }
  }
  check('every per-facility role override is supported by the source',
    unsupported === 0 && badIdx === 0 && notLinked === 0,
    `${unsupported} unsupported, ${badIdx} out-of-range, ${notLinked} on an unlinked facility` +
    `${detail.length ? ' — ' + detail.slice(0, 3).join(' | ') : ''}`);
  check('every differing per-facility role is exported', missing === 0,
    missing ? detail.filter((d) => d.startsWith('MISSING')).slice(0, 3).join(' | ') : 'none omitted');
  check('meta counts the role overrides', meta.facilityRoleOverrides === overrides,
    `meta ${meta.facilityRoleOverrides} vs rows ${overrides}`);
  note('per-facility roles',
    `${overrides} (doctor, facility) pairs where the register's licence title differs from the ` +
    `professional-level specialty; every other pair uses the professional-level value`);
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

  // Landing in `other` is a RULE REGRESSION only when the classifier had
  // something to work with. It takes three inputs — the registered name, DHA's
  // own typeGuess, and the specialties of the linked professionals — and a
  // facility can genuinely present none of them: DHA publishes no type, the
  // name matches no rule, and every professional it had has been de-listed
  // since. For those the honest answer IS "Other healthcare provider", which is
  // a real category with a label, not the "Type not published" non-answer this
  // check was written to keep out.
  //
  // So the gate holds where it can bite: a facility with a DHA type or with
  // linked professionals must never fall through. The evidence-free ones are
  // named in a NOTE so the number stays visible instead of being waved past.
  const withEvidence = unclassified.filter((f) => f.dhaType || f.doctorCount > 0);
  check('no facility with classifying evidence falls back to the unclassified bucket',
    withEvidence.length === 0,
    `${withEvidence.length} of ${unclassified.length} unclassified facilities had a DHA type or linked staff` +
    `${withEvidence.length ? ` — e.g. ${withEvidence.slice(0, 3).map((f) => f.name).join(' | ')}` : ''}`);
  if (unclassified.length > 0) {
    note('facilities with no classifying evidence',
      `${unclassified.length} have no DHA type, no matching name rule and no linked professionals: ` +
      unclassified.slice(0, 6).map((f) => f.name).join(' | '));
  }

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
      for (const r of db.prepare(`select d.${column} v from Doctor d
        where ${ACTIVE_D} and d.${column} is not null and d.${column} != ''`).iterate()) {
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
    where ${ACTIVE_D} and d.specialities like '%Show All%'
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
