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

import { classifyFacility, FACILITY_TYPES } from './facility-type.mjs';
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

// ── who counts ──────────────────────────────────────────────────────────────
// The Doctor table is a superset of the register: ScrapeFlow retains a de-listed
// professional with `removedAt` stamped rather than deleting the row. The
// directory publishes the register as it stands, so EVERY read below is scoped
// to the active set — including the relationship and licence joins, whose rows
// outlive the professional and would otherwise inflate facility counts with
// people DHA no longer lists. Nothing is deleted; the removed set is simply not
// exported, and meta.exclusions records how many that was.
const life = lifecycle(db);
console.log(`lifecycle: ${life.describe()}`);

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
//
// The DHA facility attributes are OPTIONAL columns: they are added to Facility
// by the registry and detail merges, so a database that predates those merges
// — or a minimal fixture built by the relationship tests — simply does not have
// them. Naming one in the SELECT is a hard "no such column" error that takes
// the whole export down, so the list is filtered against the live schema and a
// missing column is selected as NULL. The reader downstream already treats null
// as "the register published nothing", which is exactly right here too.
const facilityColumns = new Set(
  db.prepare('select name from pragma_table_info(?)').all('Facility').map((r) => r.name),
);
const OPTIONAL_FACILITY_COLUMNS = [
  'dhaFacilityId', 'dhaCategory', 'latitude', 'longitude', 'dhaArea', 'dhaAreaCode',
  'city', 'emirate', 'streetName', 'buildingName', 'apartmentVillaNumber',
  'makaniNumber', 'addressLine', 'facilityImage', 'addOns', 'addOnCount', 'dhaFetchedAt',
  'telephone', 'email', 'website', 'fullAddress', 'operatingHours', 'accreditations',
  'specialities', 'medicalDirector', 'headquarters', 'detailAddOns', 'detailFetchedAt',
  'foundedInDubai', 'description',
];
const optionalSelect = OPTIONAL_FACILITY_COLUMNS
  .map((c) => (facilityColumns.has(c) ? `f.${c}` : `null as ${c}`))
  .join(', ');
{
  const missing = OPTIONAL_FACILITY_COLUMNS.filter((c) => !facilityColumns.has(c));
  if (missing.length) console.log(`  facility attrs   ${missing.length} column(s) absent from this database, exported as null`);
}

const facilityRows = db.prepare(`
  select f.id, f.nameTrimmed, f.nameRaw, f.typeGuess, f.facilityTagUrl, f.isInDhaMasterList,
         ${optionalSelect},
         -- DISTINCT doctors, not rows. One professional can hold several
         -- DoctorFacility rows for the SAME facility — one per source section
         -- (search_dto, specialities, experience) — and count(*) would report
         -- each of those as another doctor.
         (select count(distinct df.doctorId) from DoctorFacility df
           where df.facilityId = f.id and ${life.viaDoctorId('df')}) as doctorCount
  from Facility f order by doctorCount desc, f.nameTrimmed asc`).all();

/** Trimmed string, or null for empty/blank/missing. Never invents a value. */
const nz = (v) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s === '' ? null : s;
};

/**
 * DHA's opening-hours payload -> [{ day, label }], or null.
 *
 * The stored value is the register's own JSON, shaped
 *   { "Sunday": { is24Hours, isClosed, timeIntervals:[{StartDropDown,EndDropDown}] }, … }
 *
 * The conversion mirrors the page's own populateOperatingHours(): 24-hour and
 * closed days short-circuit, otherwise each interval is rendered from its two
 * 24-hour integers, with DHA's own edge cases for 12 and for 24/0 meaning
 * midnight. Days the register omits are omitted here; a payload that yields no
 * usable day returns null so the section disappears rather than showing an
 * empty table.
 */
const HOUR_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hoursList = (v) => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  let o;
  try { o = JSON.parse(v); } catch { return null; }
  if (!o || typeof o !== 'object') return null;

  const clock = (h) => {
    // DHA: 24 and 0 both mean midnight; 12 stays midday.
    if (h === 0 || h === 24) return '12 AM';
    if (h === 12) return '12 PM';
    return h > 12 ? `${h - 12} PM` : `${h} AM`;
  };
  const out = [];
  for (const day of HOUR_DAYS) {
    const d = o[day];
    if (!d) continue;
    if (d.is24Hours === true || d.is24Hours === 'true') { out.push({ day, label: '24 hours' }); continue; }
    if (d.isClosed === true || d.isClosed === 'true') { out.push({ day, label: 'Closed' }); continue; }
    const spans = (Array.isArray(d.timeIntervals) ? d.timeIntervals : [])
      .map((iv) => {
        const s = parseInt(iv?.StartDropDown, 10);
        const e = parseInt(iv?.EndDropDown, 10);
        return Number.isFinite(s) && Number.isFinite(e) ? `${clock(s)} – ${clock(e)}` : null;
      })
      .filter(Boolean);
    // A day with neither a flag nor a usable interval says nothing; omit it
    // rather than printing an empty row.
    if (spans.length) out.push({ day, label: spans.join(', ') });
  }
  return out.length ? out : null;
};

/** A column stored as a JSON array string -> array, or null. Never invents. */
const jsonArray = (v) => {
  if (typeof v !== 'string' || v.trim() === '') return null;
  try { const a = JSON.parse(v); return Array.isArray(a) && a.length ? a : null; } catch { return null; }
};

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
    // Filled in by the classification pass below, once the professionals
    // linked to this facility are known. `typeGuess` is carried along as ONE
    // of the three inputs, never as the answer.
    type: null,
    typeSource: null,
    dhaType: f.typeGuess ?? null,
    doctorCount: f.doctorCount,
    inDhaMasterList: Boolean(f.isInDhaMasterList),
    sourceUrl: f.facilityTagUrl ?? null,

    // ── DHA facility attributes ────────────────────────────────────────────
    // Real values from DHA's own public facility endpoints, no authentication:
    //   registry  rest/retrieve/medicaldirectoryfacilitysearch   (name, id)
    //   map       rest/retrieve/fetchfacility?latitude&longitude  (coordinates)
    //   detail    /home/medical-directory/facility-details?facilityId=
    //             (contact, address, specialities, director, accreditations)
    // A null here means DHA returned nothing for THIS facility — never that a
    // value was withheld, inferred, or taken from a third party. Nothing in
    // this record comes from Google, maps data, or the facility's own site.
    dhaFacilityId: f.dhaFacilityId ?? null,
    dhaCategory: f.dhaCategory ?? null,
    contact: {
      // Published on the facility-details page. ~70% of facilities give a
      // phone and an email, ~39% a website; the rest leave the field blank at
      // source and stay null here.
      phone: nz(f.telephone),
      email: nz(f.email),
      website: nz(f.website),
      // DHA prints two addresses: `fullAddress` is the detail page's own
      // one-line rendering, `address` the shorter string on the map record.
      // Both are kept rather than merged — they disagree for some facilities
      // and picking one would silently discard the other.
      fullAddress: nz(f.fullAddress),
      address: f.addressLine ?? null,
      streetName: f.streetName ?? null,
      buildingName: f.buildingName ?? null,
      apartmentVillaNumber: jsonArray(f.apartmentVillaNumber),
    },
    location: {
      area: f.dhaArea ?? null,
      areaCode: f.dhaAreaCode ?? null,
      city: f.city ?? null,
      emirate: f.emirate ?? null,
      latitude: f.latitude ?? null,
      longitude: f.longitude ?? null,
      makaniNumber: jsonArray(f.makaniNumber),
    },
    // DHA's "add-ons" — extra permits/services, in DHA's own terminology. This
    // is the closest published thing to "facility operation"; the label is
    // deliberately not reinterpreted.
    addOns: jsonArray(f.addOns),
    addOnCount: f.addOnCount ?? null,
    // The detail page's own add-on list, richer than the map record's: each
    // entry carries { name, code, proposal, subTypes }.
    detailAddOns: jsonArray(f.detailAddOns),

    // ── detail-page attributes ─────────────────────────────────────────────
    /** DHA's own speciality list for the FACILITY (not its professionals'). */
    specialities: jsonArray(f.specialities),
    /** Named medical director, as printed by DHA. */
    medicalDirector: nz(f.medicalDirector),
    /** The emirate//city DHA records as the facility's headquarters. */
    headquarters: nz(f.headquarters),
    /**
     * Each entry: { accreditingBody, accreditationName, accreditationType,
     * accreditationTypeCode, issuedDate, validUntil }. Only 6.1% of facilities
     * carry any — that is DHA's own sparsity, not a gap in the crawl.
     */
    accreditations: jsonArray(f.accreditations),
    /**
     * Opening hours, as a ready-to-render list of { day, label }.
     *
     * DHA ships these as a JSON string in a `retrievedOperatingHours` JS
     * variable and assembles the list client-side, which is why a static
     * parse originally captured none of them. 1,313 facilities publish them;
     * the rest leave the variable empty and stay null here.
     *
     * The label is computed with DHA's own arithmetic (see hoursList) so the
     * directory shows what the register shows. Formatting published times is
     * not invention — but nothing is ever inferred: a facility with no payload
     * gets null, never a guessed "24 hours" or a default week.
     */
    operatingHours: hoursList(f.operatingHours),
    /** The year DHA records the facility as founded in Dubai. */
    foundedInDubai: nz(f.foundedInDubai),
    /**
     * The facility's own published blurb, VERBATIM.
     *
     * Only ~7% of facilities wrote one. It is never summarised, rewritten or
     * generated, and prose inside it that happens to mention opening times is
     * left as prose — it is never promoted into `operatingHours`.
     */
    description: nz(f.description),
    // Genuinely absent from every public DHA facility endpoint.
    licenceNumber: null,
    status: null,
    facilityOperation: null,
    /**
     * A PATH to the photo, never the photo itself.
     *
     * DHA returns the image as raw base64 PNG bytes. Inlining them put 51 MB
     * of base64 into facilities.json for 553 of 5,652 facilities — a file the
     * directory loads on EVERY page, so 90% of readers paid for images they
     * would never see and the bundle grew 4.4 MB -> 66.6 MB. The bytes are
     * written once to facility-images/ below and referenced here, so a photo
     * costs only the facility page that actually shows it.
     */
    facilityImage: f.facilityImage ? `facility-images/${f.id}.png` : null,
    dhaFetchedAt: f.dhaFetchedAt ?? null,
    dhaDetailFetchedAt: f.detailFetchedAt ?? null,
    /** Set by the roster pass below when DHA's facility-side search covered it. */
    dhaRoster: null,
    /** How many professionals DHA's facility listing returns. Null = the
     *  facility-side search has not covered this facility, which is different
     *  from "the register lists nobody" (that would be 0). */
    listedByTheRegister: null,
  };
});
// ── facility photos, written once as real PNG files ─────────────────────────
// Decoded from DHA's base64 and written beside the dataset so facilities.json
// carries a path instead of 51 MB of inlined bytes. Only facilities DHA gives a
// photo for get a file; the rest keep facilityImage: null and render nothing.
{
  const imageDir = resolve(outDir, 'facility-images');
  let written = 0;
  let bytes = 0;
  for (const f of facilityRows) {
    if (typeof f.facilityImage !== 'string' || f.facilityImage.trim() === '') continue;
    if (written === 0) mkdirSync(imageDir, { recursive: true });
    // DHA sends bare base64 with no data: prefix; tolerate one anyway.
    const b64 = f.facilityImage.replace(/^data:[^,]*,/, '');
    const buf = Buffer.from(b64, 'base64');
    // A PNG starts with the 8-byte signature 89 50 4E 47 0D 0A 1A 0A. Anything
    // else is not the image DHA claimed, so it is skipped rather than written
    // out as a corrupt file the page would try to render.
    if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) continue;
    writeFileSync(resolve(imageDir, `${f.id}.png`), buf);
    written++;
    bytes += buf.length;
  }
  console.log(`  facility photos  ${written} PNG files, ${(bytes / 1048576).toFixed(1)} MB, kept out of facilities.json`);
}

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
/**
 * The professional's PRIMARY registered facility — the one the register's own
 * search DTO carries, stored as `relationType = 'search_stage'`.
 *
 * This is the relationship DHA's `facilityName` filter counts, so it is the
 * only one that can produce a facility figure comparable with the register's.
 * The other current relationships (a licence held there, a placement the
 * profile still lists) are REAL and are kept in `linksByDoctorId` exactly as
 * before — this is a second, narrower view of the same untouched data, not a
 * replacement for it.
 */
const primaryLinksByDoctorId = new Map();
/**
 * The ROLE the professional holds AT a particular facility.
 *
 * `Doctor.speciality` is one value for the whole person — the search DTO's
 * specialty — but a licence is issued per facility and the register prints the
 * role on each one (`DoctorFacility.title`, from the profile's specialities
 * section). Those can differ: the same otolaryngologist is a Consultant at one
 * hospital and a Specialist at another; an ophthalmologist holds a separate
 * "Lasik Ophthalmology Privilege" at some of their centres and not others.
 *
 * Publishing only the professional-level value attributes ONE role to EVERY
 * facility, which both invents a specialty at facilities the register does not
 * associate it with and hides the ones it does. Keyed per (doctor, facility) so
 * a facility's specialty list and its specialty filter describe the licences
 * actually held there.
 *
 * ONLY `current_license` rows are read: that IS the licence-at-this-facility
 * relation. Employment history describes a placement, not a current licence,
 * and the search DTO carries no title at all.
 */
const roleTitlesByDoctorId = new Map(); // doctorId -> Map(facilityIdx -> Set(title))
/**
 * WHO ACTUALLY PRACTISES AT A FACILITY.
 *
 * An active licence alone is NOT enough, and assuming it was is what made this
 * wrong before. DHA's "Current licences" entry looks like:
 *
 *     General Dentist · Active License
 *     ADAM MEDICAL CENTRE L.L.C  and 1 others  [Show All]
 *         └─ Other Facilities:  A D A M CLINIC L.L.C
 *     License: 00009446-002
 *
 * The register NAMES one facility and files the rest under "Other Facilities" —
 * the other premises that one licence covers, not places the professional
 * works. Publishing every one of them as staff propagates a whole group's
 * branch list onto every professional on the group licence: PRIME MEDICAL
 * CENTER AL WARQA read 1,277 against the register's own 62, Primecorp DWC
 * 1,145 against 8.
 *
 * So a facility is this professional's WORKPLACE when an active licence covers
 * it AND the register states it directly, by any of:
 *
 *   named on the licence   the facility printed before "and N others" — the
 *                          licence's own facility, not an "Other Facilities" entry
 *   present experience     an experience record DHA marked "(Present)"
 *   search DTO             the facility the register's search stage publishes
 *
 * Measured against DHA's own facilityName filter over 25 facilities and 17,670
 * of its records: this covers 99.0% of them and is 0.6% smaller, where taking
 * every active licence was 68.4% larger.
 *
 * Every licence row is still inspected and its facility collected;
 * de-duplication happens only after the whole set is built, so a facility
 * repeated on several rows can never mask a different facility on a later row.
 * The result is UNIQUE(professional, facility), never keyed on licence number.
 * Nothing is deleted: the "Other Facilities" relationships stay in slot 6.
 */
const licensedLinksByDoctorId = new Map();   // active licence covers it
const presentLinksByDoctorId = new Map();    // experience marked "(Present)"
const relStats = {
  current: 0, historical: 0, unknownFacility: 0, primary: 0, titled: 0,
  licenceRows: 0, activeLicenceRows: 0, otherFacilityOnly: 0,
};

/**
 * Facility identity for comparing a name PRINTED in licence text against a
 * stored facility. Punctuation and spacing differ freely between the two
 * ("A D A M CLINIC L.L.C" vs "ADAM CLINIC LLC"), and this only ever decides
 * whether a facility ALREADY in the professional's active-licence set was the
 * one named on the licence — it can never introduce a facility.
 */
const facilityKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
for (const l of db.prepare(`
  select df.doctorId, df.facilityId, df.isCurrent, df.relationType, df.title, df.statusLabel
  from DoctorFacility df
  where ${life.viaDoctorId('df')}
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

  if (l.relationType === 'current_license') {
    relStats.licenceRows++;
    // "Active License" is the register's own wording; anything else (Inactive,
    // Expired) is a licence the professional may not currently practise under.
    const active = l.statusLabel === 'Active License';
    if (active) {
      relStats.activeLicenceRows++;
      let set = licensedLinksByDoctorId.get(l.doctorId);
      if (!set) licensedLinksByDoctorId.set(l.doctorId, (set = new Set()));
      set.add(idx); // a Set: dedupe is a property of the collection, not an early exit
    }
    // The role travels with the licence that states it, and only an active
    // licence describes what the person may do at that facility today.
    const title = String(l.title ?? '').replace(/\s+/g, ' ').trim();
    if (title && active) {
      relStats.titled++;
      let byFac = roleTitlesByDoctorId.get(l.doctorId);
      if (!byFac) roleTitlesByDoctorId.set(l.doctorId, (byFac = new Map()));
      let set = byFac.get(idx);
      if (!set) byFac.set(idx, (set = new Set()));
      set.add(title);
    }
  }

  if (l.relationType === 'employment_history' && l.isCurrent === 1) {
    let set = presentLinksByDoctorId.get(l.doctorId);
    if (!set) presentLinksByDoctorId.set(l.doctorId, (set = new Set()));
    set.add(idx);
  }

  if (l.relationType === 'search_stage') {
    relStats.primary++;
    let plist = primaryLinksByDoctorId.get(l.doctorId);
    if (!plist) primaryLinksByDoctorId.set(l.doctorId, (plist = []));
    if (!plist.includes(idx)) plist.push(idx);
  }
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
    ? db.prepare(`select count(*) as n from DoctorLicenceType t where ${life.viaDoctorId('t')}`).get().n
    : 0;

  if (rowCount > 0) {
    for (const l of db.prepare(`select t.doctorId, t.licenceType from DoctorLicenceType t
      where ${life.viaDoctorId('t')}`).iterate()) {
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
  select d.id, d.dhaUniqueId, d.name, d.speciality, d.facility, d.licenseType, d.nationality,
         d.languages, d.mobileNumber, d.personalEmail, d.linkedIn, d.experience, d.education,
         -- The verbatim "Current licences" text. Read to tell the facility a
         -- licence NAMES from the "Other Facilities" it also covers.
         d.specialities
  from Doctor d where ${life.doctor('d')} order by d.name asc`);

const norm = (s) => (s === null || s === undefined ? '' : String(s).replace(/\s+/g, ' ').trim());

/** Professionals the relationship layer cannot place. Reported, never hidden. */
let doctorsWithNoFacility = 0;
/**
 * Professionals whose licence types came from the primary scalar because the
 * membership pass has not reached them yet. Published in meta so the facet's
 * completeness is a number rather than an assumption.
 */
let doctorsOnPrimaryScalar = 0;
/** (doctor, facility) pairs whose role differs from the professional's own. */
let roleOverrides = 0;

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
  // The register's own primary facility for this professional (slot 10).
  const primaryIdxs = primaryLinksByDoctorId.get(d.id) ?? [];
  /**
   * Slot 12 — where this professional actually practises.
   *
   * Every active-licence facility is considered (never just the first), then
   * kept only when the register names it directly. `namedOnLicence` is read
   * from the licence text itself: DHA prints the licence's own facility before
   * "and N others", and lists the rest under "Other Facilities", which are
   * premises the licence covers rather than places the person works.
   */
  const namedOnLicence = new Set();
  for (const entry of String(d.specialities ?? '').split(' | ')) {
    const parts = entry.split(' · ');
    if (parts.length < 2) continue;
    let printed = parts[1].trim();
    const collapsed = /^(.*?)\s+and\s+\d+\s+others?\b/i.exec(printed);
    if (collapsed) printed = collapsed[1].trim();
    printed = printed.replace(/\s*Show All\s*$/i, '').trim();
    if (printed) namedOnLicence.add(facilityKey(printed));
  }
  const presentAt = presentLinksByDoctorId.get(d.id) ?? new Set();
  const licensedIdxs = [];
  for (const fi of licensedLinksByDoctorId.get(d.id) ?? []) {
    const corroborated =
      namedOnLicence.has(facilityKey(facilities[fi].name)) ||
      presentAt.has(fi) ||
      primaryIdxs.includes(fi);
    if (corroborated) licensedIdxs.push(fi);
    else relStats.otherFacilityOnly++;
  }
  licensedIdxs.sort((a, b) => a - b);
  if (facIdxs.length === 0) doctorsWithNoFacility++;
  // Former placements, kept distinct from current ones.
  const pastIdxs = (pastLinksByDoctorId.get(d.id) ?? []).filter((i) => !facIdxs.includes(i));

  // The doctor's licence-type SET — authoritative membership when the pass has
  // reached them, the primary scalar when it has not. See tools/licence-set.mjs;
  // the reconciler validates the facet through the SAME function.
  const licenceNames = licenceNamesFor(licenceTypesByDoctorId.get(d.id), d.licenseType);
  if (!licenceTypesByDoctorId.has(d.id) && licenceNames.length > 0) doctorsOnPrimaryScalar++;
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

  /**
   * Slot 11 — per-facility roles, stored SPARSELY as
   * `[[facilityIdx, specIdx, ...], ...]`.
   *
   * An entry exists only where the register's licence titles at that facility
   * are not exactly the professional-level specialty, so the common case (one
   * role everywhere) costs nothing and the reader's rule is simply: the role at
   * a facility is the override when there is one, otherwise slot 3. A facility
   * whose licences carry no title keeps slot 3 — that is not a guess, it is the
   * only role the register states for that person.
   */
  // Titles are collected as STRINGS here and interned in a second pass below.
  // Interning them inline would hand dictionary slots to role labels partway
  // through the loop and shift every later specialty index, so slot 3 would
  // change for thousands of rows that mean exactly what they meant before.
  // Deferring keeps the specialty dictionary identical up to its old length and
  // appends only the labels that are new, which makes this change provably
  // additive rather than a re-indexing of the whole file.
  const facilityRoles = [];
  {
    const byFac = roleTitlesByDoctorId.get(d.id);
    if (byFac) {
      for (const fi of facIdxs) {
        const titles = byFac.get(fi);
        if (!titles || titles.size === 0) continue;
        // Exactly the professional-level specialty => no override needed.
        if (titles.size === 1 && titles.has(specialty)) continue;
        facilityRoles.push([fi, ...titles]);
        roleOverrides++;
      }
    }
  }

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
    primaryIdxs,
    facilityRoles,
    licensedIdxs,
  ]);
}
// Facility-side roster coverage, read while the database is still open. The
// query has to live here rather than beside the facility counts below, because
// the connection is closed on the next line.
// `updatedAt` is optional for the same reason the facility attributes are: a
// fixture database built for the relationship tests carries only the columns
// those tests exercise. The roster COUNT is the load-bearing value; the
// timestamp is provenance, so it degrades to null rather than failing.
const dfColumns = new Set(
  db.prepare('select name from pragma_table_info(?)').all('DoctorFacility').map((r) => r.name),
);
const seenExpr = dfColumns.has('updatedAt') ? 'max(updatedAt)' : 'null';
const dhaRosterByFacilityId = new Map(
  db
    .prepare(
      `select facilityId, count(distinct doctorId) n, ${seenExpr} seen
         from DoctorFacility where sourceSection = 'facility_roster'
        group by facilityId`,
    )
    .all()
    .map((r) => [r.facilityId, r]),
);

db.close();

// ── resolve per-facility role titles to dictionary indexes ──────────────────
// Second pass, deliberately: every professional-level specialty has now claimed
// its slot, so the dictionary is identical to the previous schema up to its old
// length and role-only labels are appended after it. Slots 0–10 of every row
// are therefore untouched by this feature.
{
  for (const r of rows) {
    const roles = r[11];
    for (let k = 0; k < roles.length; k++) {
      const [fi, ...titles] = roles[k];
      const idxs = [];
      for (const t of titles) {
        const si = intern('specialty', t);
        if (si >= 0 && !idxs.includes(si)) idxs.push(si);
      }
      roles[k] = [fi, ...idxs];
    }
  }
}

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

  // DHA-aligned figure: professionals whose PRIMARY registered facility is this
  // one. Derived from the same exported rows, so the number on a card is
  // exactly how many the directory can list as registered here.
  const perPrimary = new Map();
  for (const r of rows) {
    for (const fi of new Set(r[10])) perPrimary.set(fi, (perPrimary.get(fi) ?? 0) + 1);
  }
  for (let i = 0; i < facilities.length; i++) facilities[i].primaryCount = perPrimary.get(i) ?? 0;

  // The facility's STAFF figure: professionals holding an active current
  // licence here. This is what a facility page counts and lists; doctorCount
  // (every current relationship) and primaryCount (the register's primary
  // registration) are retained beside it because they answer other questions.
  const perLicensed = new Map();
  for (const r of rows) {
    for (const fi of new Set(r[12])) perLicensed.set(fi, (perLicensed.get(fi) ?? 0) + 1);
  }
  for (let i = 0; i < facilities.length; i++) facilities[i].licensedCount = perLicensed.get(i) ?? 0;

  // ── the two professional counts, named apart ───────────────────────────────
  // These are DIFFERENT METRICS and must never be collapsed into one number:
  //
  //   professionalsWorkingHere  professionals holding an ACTIVE current licence
  //                             corroborated at this facility. This is the set
  //                             the page actually lists, so it is the one a
  //                             reader can click through and count.
  //   listedByTheRegister       how many professionals DHA's own facility-side
  //                             search returns for this facility. Validated to
  //                             equal the roster we actually stored.
  //
  // The gap between them is expected and explainable: the register's facility
  // listing includes professionals whose licence record does not independently
  // corroborate this workplace, which the staff rule deliberately excludes.
  // A difference is information, not an error — and never a reason to remove.
  for (const f of facilities) f.professionalsWorkingHere = f.licensedCount;

  // ── DHA facility-side roster coverage ──────────────────────────────────────
  // The facility_roster rows come from querying DHA's search by facilityName —
  // the register's own facility-side view. Recording how many professionals DHA
  // lists there, beside our own count, lets a reader see the two agree (or not)
  // instead of having to trust one number. It is EVIDENCE, never a correction:
  // DHA's facility view lists only CURRENT professionals while the directory
  // also holds employment history, so a lower DHA figure is expected and is
  // never treated as a removal.
  {
    let covered = 0;
    for (const f of facilities) {
      const r = dhaRosterByFacilityId.get(f.id);
      if (!r) continue;
      covered++;
      f.listedByTheRegister = r.n;
      f.dhaRoster = {
        listedByDha: r.n,
        checkedAt: r.seen ?? null,
        source: 'DHA medical-directory search, filtered to this facility',
      };
    }
    relStats.facilitiesWithDhaRoster = covered;
  }
  // NOTE: facilities must NOT be re-sorted here. A facility's position in this
  // array IS its dictionary index, and doctor rows already reference it.
  // Consumers that want "most staffed first" sort a copy at read time.
}

// ── facility type, classified ───────────────────────────────────────────────
/**
 * Every facility gets a type. `Facility.typeGuess` is null for a sixth of the
 * register, which the directory used to publish as "Type not published" — a
 * non-answer dressed up as a category.
 *
 * The type is derived instead by tools/facility-type.mjs from three inputs, in
 * this order: the registered NAME (normalised, ordered rules, specific beats
 * generic), then `typeGuess` as corroboration, then the SPECIALTIES of the
 * professionals the register itself linked to the facility. `typeSource`
 * records which of the three answered, so the detail page can say so rather
 * than implying the register published it.
 *
 * The staff tally is built from the SAME exported rows the directory will show,
 * so a classification can never rest on a relationship the export dropped.
 */
const facilityTypeStats = { byType: new Map(), bySource: new Map() };
{
  const staffByFacilityIdx = new Map();
  for (const r of rows) {
    const si = r[3];
    if (si < 0) continue;
    for (const fi of new Set(r[6])) {
      let tally = staffByFacilityIdx.get(fi);
      if (!tally) staffByFacilityIdx.set(fi, (tally = new Map()));
      tally.set(si, (tally.get(si) ?? 0) + 1);
    }
  }

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    const tally = staffByFacilityIdx.get(i);
    const staff = tally
      ? [...tally].map(([si, count]) => ({ label: dict.specialty[si] ?? '', count }))
      : [];
    const { type, source } = classifyFacility({ name: f.name, dhaType: f.dhaType, staff });
    f.type = type;
    f.typeSource = source;
    facilityTypeStats.byType.set(type, (facilityTypeStats.byType.get(type) ?? 0) + 1);
    facilityTypeStats.bySource.set(source, (facilityTypeStats.bySource.get(source) ?? 0) + 1);
  }
}
const unclassifiedFacilities = facilityTypeStats.byType.get('other') ?? 0;

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
  // v4: row slot 10 is primaryFacilityIdxs — the register's own primary
  // facility for the professional, which is what DHA's facility filter counts.
  // v5: row slot 11 is facilityRoles — the role held AT a given facility, where
  // the register's licence title there differs from the professional-level
  // specialty. Sparse: absent means "slot 3 applies at this facility".
  // v6: row slot 12 is licensedFacilityIdxs — facilities where the professional
  // holds an ACTIVE current licence. This is a facility's staff population;
  // slot 6 (every current relationship) and slot 10 (primary registration)
  // remain unchanged beside it and answer different questions.
  version: 6,
  /** Which source the licence-type facet was built from. */
  licenceTypeSource,
  /**
   * How many professionals fell back to the primary scalar because the
   * membership pass has not covered them yet (see tools/licence-set.mjs).
   * 0 means every published licence type came from the authoritative set.
   */
  licenceTypeFallbackDoctors: doctorsOnPrimaryScalar,
  /**
   * Which professionals this dataset represents. `source` names the column the
   * active set was derived from, so a dataset built against a database with no
   * lifecycle tracking is recognisably different from one that filtered.
   */
  lifecycle: {
    source: life.source,
    totalDoctorRecords: life.totalDoctors,
    activeDoctors: life.activeDoctors,
    removedDoctors: life.removedDoctors,
  },
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
    facilityTypes: facilityTypeStats.byType.size,
    /** Sum of primaryCount — distinct (doctor, primary facility) pairs. */
    doctorPrimaryFacilityLinks: facilities.reduce((s, f) => s + f.primaryCount, 0),
    /**
     * Sum of licensedCount — distinct (doctor, facility) pairs backed by an
     * ACTIVE current licence. The facility staff population.
     */
    doctorLicensedFacilityLinks: facilities.reduce((s, f) => s + f.licensedCount, 0),
  },
  /**
   * The facility-type vocabulary, shipped WITH the data so the UI can never
   * fall out of step with the classifier. A key the reader does not recognise
   * still reads correctly because its label travels alongside it.
   */
  facilityTypeLabels: FACILITY_TYPES,
  /**
   * How the classification actually landed, per type and per source. Published
   * so the split between "read from the name", "corroborated by DHA's guess"
   * and "inferred from the linked professionals" is auditable rather than
   * asserted. `unclassified` MUST be 0 — see the reconciler's check.
   */
  facilityTypeCounts: Object.fromEntries(
    [...facilityTypeStats.byType].sort((a, b) => b[1] - a[1]),
  ),
  facilityTypeSources: Object.fromEntries(
    [...facilityTypeStats.bySource].sort((a, b) => b[1] - a[1]),
  ),
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
    /**
     * Facilities the classifier could place in no type at all. Reported so a
     * regression in the rules is a number rather than a surprise in the UI.
     */
    facilitiesWithNoType: unclassifiedFacilities,
    /**
     * Professionals DHA no longer lists. Their rows, relationships, licences
     * and profiles are all retained in ScrapeFlow; none of it is published.
     */
    removedProfessionals: life.removedDoctors,
  },
  flags: FLAG,
  rowSchema: ['id', 'name', 'categoryIdx', 'specialtyIdx', 'licenceTypeIdxs', 'nationalityIdx', 'facilityIdxs', 'languageIdxs', 'flags', 'pastFacilityIdxs', 'primaryFacilityIdxs', 'facilityRoles', 'licensedFacilityIdxs'],
  /**
   * (doctor, facility) pairs where the register's licence title at that
   * facility is not the professional-level specialty, and slot 11 therefore
   * carries an override. Published so the size of the correction is auditable.
   */
  facilityRoleOverrides: roleOverrides,
};

const write = (file, obj) => {
  const p = resolve(outDir, file);
  writeFileSync(p, JSON.stringify(obj));
  console.log(`  ${file.padEnd(18)} ${(statSync(p).size / 1048576).toFixed(2)} MB`);
};

write('meta.json', meta);
write('facets.json', { version: 1, dict, facets });
write('facilities.json', { version: 2, facilityTypeLabels: FACILITY_TYPES, facilities });
write('doctors.json', { version: 6, count: rows.length, rows });

console.log('\ndone.');
console.log(`  doctors    ${meta.totals.doctors.toLocaleString()}`);
console.log(`  facilities ${meta.totals.facilities.toLocaleString()}`);
console.log(`  licence types  ${facets.licenseType.map((x) => `${x.label}=${x.count}`).join(' · ')}`);
console.log(`  licence source ${licenceTypeSource}`);
console.log(`  primary links  ${meta.totals.doctorPrimaryFacilityLinks.toLocaleString()} (DHA-aligned) vs ${meta.totals.doctorFacilityLinks.toLocaleString()} all-linked`);
console.log(`  staff links    ${meta.totals.doctorLicensedFacilityLinks.toLocaleString()} (active licence corroborated by the register)`);
console.log(`  licence rows   ${relStats.licenceRows.toLocaleString()} current, of which ${relStats.activeLicenceRows.toLocaleString()} active`);
console.log(`  other-facility ${relStats.otherFacilityOnly.toLocaleString()} licence coverages held back from staff lists (kept in all-linked)`);
console.log(`  facility types ${facilityTypeStats.byType.size} in use · unclassified ${unclassifiedFacilities}`);
for (const [type, n] of [...facilityTypeStats.byType].sort((a, b) => b[1] - a[1])) {
  console.log(`      ${String(n).padStart(5)}  ${(FACILITY_TYPES[type] ?? type).padEnd(38)} ${type}`);
}
console.log(`  type source    ${[...facilityTypeStats.bySource].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}=${n}`).join(' · ')}`);
console.log(`  removed        ${life.removedDoctors.toLocaleString()} de-listed professionals (not exported)`);
console.log(`  no facility    ${doctorsWithNoFacility.toLocaleString()} professionals (excluded, see meta.exclusions)`);
console.log(`  specialties ${meta.totals.specialties} · categories ${meta.totals.categories} · languages ${meta.totals.languages} · nationalities ${meta.totals.nationalities}`);

