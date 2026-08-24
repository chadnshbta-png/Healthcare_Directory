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
for (const l of db.prepare(`
  select df.doctorId, df.facilityId
  from DoctorFacility df
  order by df.isCurrent desc, df.createdAt asc`).all()) {
  const idx = facilityIndexById.get(l.facilityId);
  if (idx === undefined) continue;
  let list = linksByDoctorId.get(l.doctorId);
  if (!list) linksByDoctorId.set(l.doctorId, (list = []));
  if (!list.includes(idx)) list.push(idx);
}

// ── doctors ─────────────────────────────────────────────────────────────────
const FLAG = { MOBILE: 1, EMAIL: 2, LINKEDIN: 4, EXPERIENCE: 8, EDUCATION: 16 };
const rows = [];
const stmt = db.prepare(`
  select id, dhaUniqueId, name, speciality, facility, licenseType, nationality, languages,
         mobileNumber, personalEmail, linkedIn, experience, education
  from Doctor order by name asc`);

const norm = (s) => (s === null || s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim());

for (const d of stmt.iterate()) {
  const spec = norm(d.speciality);
  const dash = spec.indexOf('-');
  const category = dash > 0 ? spec.slice(0, dash).trim() : spec;
  const specialty = dash > 0 ? spec.slice(dash + 1).trim() : '';

  // Prefer the relational links. Fall back to Doctor.facility only when the
  // join has nothing for this doctor, so a facility known solely from the
  // search stage is still published rather than dropped.
  let facIdxs = linksByDoctorId.get(d.id) ?? [];
  if (facIdxs.length === 0) {
    const facName = norm(d.facility);
    if (facName) {
      facIdxs = [
        facilityIndexByName.has(facName)
          ? facilityIndexByName.get(facName)
          : intern('facility', facName),
      ];
    }
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
    intern('licenseType', norm(d.licenseType)),
    intern('nationality', norm(d.nationality)),
    facIdxs,
    langs,
    flags,
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
  licenseType: facetList('licenseType', countBy((r) => r[4])),
  nationality: facetList('nationality', countBy((r) => r[5])),
  language: facetList('language', countBy((r) => r[7])),
  facility: facetList('facility', countBy((r) => r[6])).slice(0, 6000),
};

const withContact = rows.filter((r) => r[8] & (FLAG.MOBILE | FLAG.EMAIL)).length;
const meta = {
  generatedAt: new Date().toISOString(),
  // v2: row slot 6 is facilityIdxs (an ARRAY) rather than a single facilityIdx.
  version: 2,
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
  flags: FLAG,
  rowSchema: ['id', 'name', 'categoryIdx', 'specialtyIdx', 'licenseTypeIdx', 'nationalityIdx', 'facilityIdxs', 'languageIdxs', 'flags'],
};

const write = (file, obj) => {
  const p = resolve(outDir, file);
  writeFileSync(p, JSON.stringify(obj));
  console.log(`  ${file.padEnd(18)} ${(statSync(p).size / 1048576).toFixed(2)} MB`);
};

write('meta.json', meta);
write('facets.json', { version: 1, dict, facets });
write('facilities.json', { version: 1, facilities });
write('doctors.json', { version: 2, count: rows.length, rows });

console.log('\ndone.');
console.log(`  doctors    ${meta.totals.doctors.toLocaleString()}`);
console.log(`  facilities ${meta.totals.facilities.toLocaleString()}`);
console.log(`  specialties ${meta.totals.specialties} · categories ${meta.totals.categories} · languages ${meta.totals.languages} · nationalities ${meta.totals.nationalities}`);
