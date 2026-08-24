#!/usr/bin/env node
/**
 * Doctorna Directory — static data exporter (OPTIONAL TOOL)
 * ---------------------------------------------------------
 * The Directory ships with its data already generated in ./data, so this tool
 * is NOT required to run the site. It exists only to regenerate that data from
 * a DHA-shaped SQLite database.
 *
 * Usage:
 *   node tools/export-data.mjs --db ../path/to/dev.db [--out ./data]
 *
 * There are no hardcoded paths: the database location is always supplied by the
 * caller. The exporter READS the database and WRITES only inside --out.
 *
 * Output files (see ../README.md for full schemas):
 *   data/meta.json        totals + generation timestamp
 *   data/facets.json      filter dictionaries with counts (small, loads first)
 *   data/doctors.json     dictionary-encoded doctor rows (the large payload)
 *   data/facilities.json  facility cards with doctor counts
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
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
  console.error('ERROR: --db <path-to-sqlite> is required.\n' +
    'Example: node tools/export-data.mjs --db ../backend/prisma/dev.db');
  process.exit(1);
}
const dbPath = resolve(process.cwd(), args.db);
const outDir = resolve(here, '..', typeof args.out === 'string' ? args.out : 'data');
mkdirSync(outDir, { recursive: true });

console.log(`reading  : ${dbPath}`);
console.log(`writing  : ${outDir}`);

const db = new DatabaseSync(dbPath, { readOnly: true });

// ── dictionaries ────────────────────────────────────────────────────────────
const dict = { category: [], specialty: [], licenseType: [], nationality: [], language: [], facility: [] };
const idx = { category: new Map(), specialty: new Map(), licenseType: new Map(), nationality: new Map(), language: new Map(), facility: new Map() };
const intern = (kind, value) => {
  if (value === null || value === undefined || value === '') return -1;
  const m = idx[kind];
  if (m.has(value)) return m.get(value);
  const i = dict[kind].length;
  dict[kind].push(value);
  m.set(value, i);
  return i;
};

// ── facilities first (their index is shared with doctor rows) ───────────────
const facilityRows = db.prepare(`
  select f.id, f.nameTrimmed, f.nameRaw, f.typeGuess, f.facilityTagUrl, f.isInDhaMasterList,
         -- DISTINCT doctors, not rows. One professional can hold several
         -- DoctorFacility rows for the SAME facility — one per source section
         -- (search_dto, specialities, experience) — and count(*) would report
         -- each of those as another doctor.
         (select count(distinct df.doctorId) from DoctorFacility df where df.facilityId = f.id) as doctorCount
  from Facility f order by doctorCount desc, f.nameTrimmed asc`).all();

const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const usedSlugs = new Map();
const facilities = facilityRows.map((f, i) => {
  let slug = slugify(f.nameTrimmed) || 'facility';
  const n = (usedSlugs.get(slug) ?? 0) + 1;
  usedSlugs.set(slug, n);
  if (n > 1) slug = `${slug}-${n}`;

  // ONE dictionary slot per facility ROW, in the same order, so that a facility
  // dictionary index and a facilities[] position are always the same thing.
  //
  // `intern()` must NOT be used here: it de-duplicates by name, but facilities
  // are unique by nameRaw, not nameTrimmed — 63 rows share 14 trimmed names.
  // De-duplicating would make the dictionary shorter than the array and every
  // later index would point at the wrong facility, because the reader resolves
  // a record as facilities[dictIdx].
  dict.facility.push(f.nameTrimmed);
  if (!idx.facility.has(f.nameTrimmed)) idx.facility.set(f.nameTrimmed, i);

  return {
    id: f.id,
    slug,
    name: f.nameTrimmed,
    type: f.typeGuess ?? null,
    doctorCount: f.doctorCount,
    inDhaMasterList: Boolean(f.isInDhaMasterList),
    sourceUrl: f.facilityTagUrl ?? null,
  };
});
// name -> facility dictionary index, for linking doctors by their facility string
const facilityIndexByName = new Map(facilities.map((f, i) => [f.name, i]));
// facility row id -> dictionary index, for linking via the join table
const facilityIndexById = new Map(facilities.map((f, i) => [f.id, i]));

/**
 * Every facility a doctor is linked to, read from the RELATIONAL table.
 *
 * Doctor.facility is a single denormalised string and can only ever describe
 * one placement; DoctorFacility is the model that actually supports several.
 * Reading the join here is what lets a professional with concurrent facilities
 * export all of them instead of silently losing every one but the first.
 * Current placements come first, then oldest-recorded.
 */
const linksByDoctorId = new Map();
const pastLinksByDoctorId = new Map();
const relStats = { current: 0, historical: 0, unknownFacility: 0 };
for (const l of db.prepare(`
  select df.doctorId, df.facilityId, df.isCurrent, df.relationType
  from DoctorFacility df
  order by df.isCurrent desc, df.createdAt asc`).all()) {
  const idx = facilityIndexById.get(l.facilityId);
  if (idx === undefined) { relStats.unknownFacility++; continue; }

  // CURRENT means the register still lists the placement: a live licence
  // (specialities), the search stage's own facility, or an experience entry DHA
  // marked "(Present)". Everything else is a job the professional has LEFT.
  //
  // Both are kept — DoctorFacility is the authoritative relationship layer and
  // nothing is collapsed — but only current placements answer "where does this
  // person work", so publishing a former employer as a facility would be a
  // regression dressed up as more data.
  const isCurrent =
    l.isCurrent === 1 ||
    l.relationType === 'current_license' ||
    l.relationType === 'search_stage';

  const bucket = isCurrent ? linksByDoctorId : pastLinksByDoctorId;
  relStats[isCurrent ? 'current' : 'historical']++;
  let list = bucket.get(l.doctorId);
  if (!list) bucket.set(l.doctorId, (list = []));
  if (!list.includes(idx)) list.push(idx);
}

/**
 * Licence-TYPE membership, per doctor.
 *
 * A professional can hold several licence types at once — the register's own
 * filter buckets sum to more than the population. `Doctor.licenseType` is the
 * search API's single PRIMARY value, so a facet built from it undercounts every
 * bucket but the biggest (Part-time read 32 against the register's ~3,684).
 *
 * DoctorLicenceType is the authoritative set. When it has not been populated
 * yet the export falls back to the scalar and SAYS SO in meta, rather than
 * quietly shipping a number that looks fine and is not.
 */
const licenceTypesByDoctorId = new Map();
let licenceTypeSource = 'doctor_licence_type';
{
  const hasTable = db
    .prepare("select count(*) as n from sqlite_master where type='table' and name='DoctorLicenceType'")
    .get().n > 0;
  const rowCount = hasTable
    ? db.prepare('select count(*) as n from DoctorLicenceType').get().n
    : 0;

  if (rowCount > 0) {
    for (const l of db.prepare('select doctorId, licenceType from DoctorLicenceType').iterate()) {
      let list = licenceTypesByDoctorId.get(l.doctorId);
      if (!list) licenceTypesByDoctorId.set(l.doctorId, (list = []));
      if (!list.includes(l.licenceType)) list.push(l.licenceType);
    }
  } else {
    licenceTypeSource = 'doctor_scalar_fallback';
  }
}

// ── doctors ─────────────────────────────────────────────────────────────────
const FLAG = { MOBILE: 1, EMAIL: 2, LINKEDIN: 4, EXPERIENCE: 8, EDUCATION: 16 };
const rows = [];
const stmt = db.prepare(`
  select id, dhaUniqueId, name, speciality, facility, licenseType, nationality, languages,
         mobileNumber, personalEmail, linkedIn, experience, education
  from Doctor order by name asc`);

const norm = (s) => (s === null || s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim());

/** The search DTO's codes, expanded to the register's own filter vocabulary. */
const PRIMARY_LICENCE_LABEL = {
  FTL: 'Full-time License',
  PTL: 'Part-time License',
  REG: 'Registered Only',
  TRL: 'Trainee License',
};

/** Professionals the relationship layer cannot place. Reported, never hidden. */
let doctorsWithNoFacility = 0;

for (const d of stmt.iterate()) {
  const spec = norm(d.speciality);
  const dash = spec.indexOf('-');
  const category = dash > 0 ? spec.slice(0, dash).trim() : spec;
  const specialty = dash > 0 ? spec.slice(dash + 1).trim() : '';

  // DoctorFacility is the ONLY source of facilities. There is deliberately no
  // fallback to the Doctor.facility scalar: every scalar that resolves to a
  // real facility is already a `search_stage` row in the join, so a fallback
  // would only ever re-add names the matcher REFUSED to resolve — publishing a
  // guess as though it were a relationship. Doctors left with none are counted
  // in meta.exclusions instead of being papered over.
  const facIdxs = linksByDoctorId.get(d.id) ?? [];
  if (facIdxs.length === 0) doctorsWithNoFacility++;
  // Former placements, kept distinct from current ones.
  const pastIdxs = (pastLinksByDoctorId.get(d.id) ?? []).filter((i) => !facIdxs.includes(i));

  // The doctor's licence-type SET. Falls back to the primary scalar only when
  // the join table is empty, and meta records which of the two was used.
  const licenceNames = licenceTypesByDoctorId.get(d.id)
    ?? (norm(d.licenseType) ? [PRIMARY_LICENCE_LABEL[norm(d.licenseType)] ?? norm(d.licenseType)] : []);
  const licenceIdxs = [];
  for (const name of licenceNames) {
    const i = intern('licenseType', name);
    if (i >= 0 && !licenceIdxs.includes(i)) licenceIdxs.push(i);
  }

  const langs = norm(d.languages)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => intern('language', x));

  let flags = 0;
  if (norm(d.mobileNumber)) flags |= FLAG.MOBILE;
  if (norm(d.personalEmail)) flags |= FLAG.EMAIL;
  if (norm(d.linkedIn)) flags |= FLAG.LINKEDIN;
  if (norm(d.experience)) flags |= FLAG.EXPERIENCE;
  if (norm(d.education)) flags |= FLAG.EDUCATION;

  rows.push([
    d.dhaUniqueId,
    norm(d.name),
    intern('category', category),
    intern('specialty', specialty),
    licenceIdxs,
    intern('nationality', norm(d.nationality)),
    facIdxs,
    langs,
    flags,
    pastIdxs,
  ]);
}
db.close();

// ── reconcile facility counts with what was actually exported ───────────────
// doctorCount came from a COUNT over DoctorFacility, but a row can also reach a
// facility through the Doctor.facility fallback (used when the matcher refused
// to resolve a colliding name). Deriving the published count from the exported
// rows instead makes the snapshot self-consistent by construction: the number on
// a facility card is exactly how many professionals the directory will list for
// it. Counted per DISTINCT doctor.
{
  const perFacility = new Map();
  for (const r of rows) {
    for (const fi of new Set(r[6])) perFacility.set(fi, (perFacility.get(fi) ?? 0) + 1);
  }
  for (let i = 0; i < facilities.length; i++) facilities[i].doctorCount = perFacility.get(i) ?? 0;
  // NOTE: facilities must NOT be re-sorted here. A facility's position in this
  // array IS its dictionary index, and doctor rows already reference it.
  // Consumers that want "most staffed first" sort a copy at read time.
}

// ── facet counts (so the filter UI can render before the big file lands) ────
const countBy = (getter) => {
  const m = new Map();
  for (const r of rows) {
    const v = getter(r);
    if (Array.isArray(v)) for (const x of v) m.set(x, (m.get(x) ?? 0) + 1);
    else if (v >= 0) m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
};
const facetList = (kind, counts, extra = () => ({})) =>
  dict[kind]
    .map((label, i) => ({ i, label, count: counts.get(i) ?? 0, ...extra(i) }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

const facets = {
  category: facetList('category', countBy((r) => r[2])),
  specialty: facetList('specialty', countBy((r) => r[3])),
  // r[4] is an ARRAY now, so countBy's array branch counts a doctor once in
  // EVERY bucket they belong to — which is the whole point.
  licenseType: facetList('licenseType', countBy((r) => r[4])),
  nationality: facetList('nationality', countBy((r) => r[5])),
  language: facetList('language', countBy((r) => r[7])),
  facility: facetList('facility', countBy((r) => r[6])).slice(0, 6000),
};

const withContact = rows.filter((r) => r[8] & (FLAG.MOBILE | FLAG.EMAIL)).length;
const meta = {
  generatedAt: new Date().toISOString(),
  // v3: row slot 4 is licenceTypeIdxs (an ARRAY) rather than a single index —
  // a professional can hold several licence types at once. Slot 6 became an
  // array in v2 for the same reason on the facility side.
  version: 3,
  /** Which source the licence-type facet was built from. */
  licenceTypeSource,
  totals: {
    doctors: rows.length,
    facilities: facilities.length,
    facilitiesWithDoctors: facilities.filter((f) => f.doctorCount > 0).length,
    // Sum of DISTINCT doctors per facility = distinct (doctor, facility) pairs.
    doctorFacilityLinks: facilities.reduce((s, f) => s + f.doctorCount, 0),
    specialties: facets.specialty.length,
    categories: facets.category.length,
    nationalities: facets.nationality.length,
    languages: facets.language.length,
    doctorsWithContact: withContact,
  },
  /**
   * What the export deliberately leaves out, so an absence is measurable
   * rather than mysterious. Anything counted here is a known gap, not a bug.
   */
  exclusions: {
    /**
     * Professionals with no resolvable facility relationship. Their facility
     * name either was never published or did not match exactly one Facility
     * row, and the export refuses to guess.
     */
    doctorsWithNoFacility,
  },
  flags: FLAG,
  rowSchema: ['id', 'name', 'categoryIdx', 'specialtyIdx', 'licenceTypeIdxs', 'nationalityIdx', 'facilityIdxs', 'languageIdxs', 'flags', 'pastFacilityIdxs'],
};

const write = (file, obj) => {
  const p = resolve(outDir, file);
  writeFileSync(p, JSON.stringify(obj));
  console.log(`  ${file.padEnd(18)} ${(statSync(p).size / 1048576).toFixed(2)} MB`);
};

write('meta.json', meta);
write('facets.json', { version: 1, dict, facets });
write('facilities.json', { version: 1, facilities });
write('doctors.json', { version: 3, count: rows.length, rows });

console.log('\ndone.');
console.log(`  doctors    ${meta.totals.doctors.toLocaleString()}`);
console.log(`  facilities ${meta.totals.facilities.toLocaleString()}`);
console.log(`  licence types  ${facets.licenseType.map((x) => `${x.label}=${x.count}`).join(' · ')}`);
console.log(`  licence source ${licenceTypeSource}`);
console.log(`  no facility    ${doctorsWithNoFacility.toLocaleString()} professionals (excluded, see meta.exclusions)`);
console.log(`  specialties ${meta.totals.specialties} · categories ${meta.totals.categories} · languages ${meta.totals.languages} · nationalities ${meta.totals.nationalities}`);
